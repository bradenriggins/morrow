import { describe, expect, it } from "vitest";
import { canvasAccountAuthorityRoute, canvasAdmissionReason, canvasCatalogTools, canvasOperationAdmission, canvasReadbackAssessment, canvasSemanticContextInputState, canvasSemanticCourseCollectionArguments, canvasSemanticCourseCollectionState, canvasSemanticCourseTarget, canvasSemanticObjectContext, canvasSemanticObjectVersion, canvasSemanticResolutionProblem, canvasSemanticResolvedCourseId, canvasSemanticSeriesInput, canvasSemanticVersionState, evaluateBrowserReadback, parseCanvasApiCatalog, operationArguments, planBrowserReadback } from "../src/index.js";
import catalogJson from "../../../artifacts/canvas-api/canvas-api-catalog.json";

const catalog = parseCanvasApiCatalog(catalogJson);

describe("Canvas API catalog", () => {
  it("covers the official surface plus the browser-session Item Banks contract", () => {
    expect(catalog.counts.officialOperations).toBeGreaterThanOrEqual(1_100);
    expect(catalog.counts.itemBankOperations).toBe(13);
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
      { inputName: "column_position", wireName: "column[position]", required: false, schema: { type: "string" } },
      { inputName: "column_read_only", wireName: "column[read_only]", required: false, schema: { type: "boolean" } },
      { inputName: "column_teacher_notes", wireName: "column[teacher_notes]", required: false, schema: { type: "boolean" } },
      { inputName: "column_title", wireName: "column[title]", required: false, schema: { type: "string" } },
    ]);
    expect(operationArguments(operation!, {
      course_id: "42",
      id: "7",
      column_title: "Participation",
      column_position: "3",
      column_hidden: true,
      column_teacher_notes: true,
      column_read_only: false,
    })).toEqual({
      path: "/v1/courses/42/custom_gradebook_columns/7",
      query: [],
      body: [
        ["column[hidden]", true],
        ["column[position]", "3"],
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
    expect(operationArguments(read!, { bank_id: "901", item_id: "502" }).path).toBe("/api/banks/901/items/502");

    const shares = catalog.operations.find((candidate) => candidate.toolName === "canvas_item_bank_list_shares");
    expect(shares!.parameters.map((parameter) => [parameter.inputName, parameter.location]))
      .toEqual([["bank_id", "path"], ["page", "form"], ["per_page", "form"]]);

    const share = catalog.operations.find((candidate) => candidate.toolName === "canvas_item_bank_share_bank");
    expect(share!.inputSchema).toMatchObject({
      properties: {
        entity_type: { type: "string", enum: ["course"] },
        permission: { type: "string", enum: ["read"] },
      },
    });
    expect(share!.description).toContain("Only the course entity type and the read permission are verified.");
  });

  // Every Item Bank write is held, so canvasReadbackAssessment answers "write_held" before it plans
  // anything. These cases call the planner directly, which is the only way to read the plan an
  // admitted Item Bank write would use.
  it("compares an Item Bank item write against the saved item, not against the entry list", () => {
    const update = catalog.operations.find((candidate) => candidate.toolName === "canvas_item_bank_update_item")!;
    const create = catalog.operations.find((candidate) => candidate.toolName === "canvas_item_bank_create_item")!;
    expect(canvasReadbackAssessment(catalog.operations, update)).toEqual({ state: "not_applicable", reason: "write_held" });

    const item = { entry: { item_body: "<p>Which vessel carries oxygenated blood?</p>" } };
    const saved = { id: "502", entry: { item_body: "<p>Which vessel carries oxygenated blood?</p>", position: 3 } };

    const updatePlan = planBrowserReadback(catalog.operations, update, { bank_id: "901", item_id: "502", item }, { id: "502" });
    expect(updatePlan?.readOperation.toolName).toBe("canvas_item_bank_get_item");
    expect(updatePlan?.strategy).toBe("updated-resource");
    expect(updatePlan?.arguments).toEqual({ bank_id: "901", item_id: "502" });
    expect(updatePlan?.targetId).toBeUndefined();
    expect(evaluateBrowserReadback(updatePlan, { ok: true, status: 200, data: saved }).status).toBe("verified");
    expect(evaluateBrowserReadback(updatePlan, {
      ok: true,
      status: 200,
      data: { id: "502", entry: { item_body: "<p>Unchanged.</p>" } },
    }).status).toBe("mismatch");

    const createPlan = planBrowserReadback(catalog.operations, create, { bank_id: "901", item }, { id: "502" });
    expect(createPlan?.readOperation.toolName).toBe("canvas_item_bank_get_item");
    expect(createPlan?.strategy).toBe("created-resource");
    expect(createPlan?.arguments).toEqual({ bank_id: "901", item_id: "502" });
    expect(createPlan?.targetId).toBe("502");
    expect(createPlan?.targetField).toBe("id");
    expect(evaluateBrowserReadback(createPlan, { ok: true, status: 200, data: saved }).status).toBe("verified");
    // The create response carries the only identity the new item has. Without it there is no
    // comparator, and the entry list cannot stand in: the item is not an entry until attach_item runs.
    expect(planBrowserReadback(catalog.operations, create, { bank_id: "901", item }, {})).toBeNull();
  });

  it("keeps the Item Bank entry-list comparator only where a bank entry is what changed", () => {
    const writes = catalog.operations.filter((operation) => operation.service === "item_bank" && !operation.readOnly);
    const planned = writes.map((operation) => [
      operation.nickname,
      planBrowserReadback(catalog.operations, operation, {
        bank_id: "901",
        item_id: "502",
        bank_entry_id: "701",
        entity_type: "course",
        entity_id: "42",
        title: "Cardiovascular anatomy",
      }, { id: "801" })?.readOperation.nickname,
    ]);
    // attach_item and delete_entry change the bank's entry rows, so the entry routes are their exact
    // comparators. No item write reads the entry list.
    expect(Object.fromEntries(planned)).toEqual({
      create_bank: "get_bank",
      archive_bank: "get_bank",
      attach_item: "list_entries",
      create_item: "get_item",
      update_item: "get_item",
      delete_entry: "get_entry",
      share_bank: "list_shares",
    });
  });

  it("derives public write availability from one admission contract", () => {
    const tools = canvasCatalogTools(catalog);
    expect(tools).toHaveLength(catalog.counts.totalOperations);
    const writes = catalog.operations.filter((operation) => !operation.readOnly);
    const held = writes.filter((operation) => canvasOperationAdmission(operation).write.state === "held");
    // The Item Bank dependency holds are counted apart from the rest: they are not a missing course
    // binding but an unproved effect on other courses. The question update carries its own reason
    // for the same class of hold, so both stay outside this count.
    const itemBankDependencyHolds = new Set(["item_bank_dependency_review_required", "item_bank_fan_out_and_guard_required"]);
    const supportedButBlocked = held.filter((operation) => !itemBankDependencyHolds.has(String(canvasOperationAdmission(operation).write.reason)));
    expect(held).toHaveLength(327);
    expect(supportedButBlocked).toHaveLength(321);
    expect(tools.filter((tool) => tool.capability?.profiles["public-canvas"].state !== "supported")).toHaveLength(327);
    expect(tools.filter((tool) => tool.capability?.family === "new-quizzes-item-banks")).toHaveLength(13);
  });

  it("admits a direct course route and holds every other write target", () => {
    const direct = catalog.operations.find((operation) => operation.toolName === "canvas_update_course");
    const nickname = catalog.operations.find((operation) => operation.toolName === "canvas_set_course_nickname");
    const createBank = catalog.operations.find((operation) => operation.toolName === "canvas_item_bank_create_bank");
    const existingBank = catalog.operations.find((operation) => operation.toolName === "canvas_item_bank_update_item");
    const bookmark = catalog.operations.find((operation) => operation.toolName === "canvas_update_bookmark");
    expect(canvasOperationAdmission(direct!)).toEqual({
      courseTarget: { kind: "course_path", argument: "id" },
      write: { state: "admitted" },
    });
    expect(canvasOperationAdmission(nickname!)).toEqual({
      courseTarget: { kind: "self_path", resource: "course_nickname", argument: "course_id" },
      write: { state: "held", reason: "self_scope_not_supported" },
    });
    expect(canvasOperationAdmission(createBank!)).toMatchObject({
      courseTarget: { kind: "none" },
      write: { state: "held", reason: "item_bank_account_scope_not_course_scope" },
    });
    expect(canvasOperationAdmission(existingBank!)).toMatchObject({
      write: { state: "held", reason: "item_bank_fan_out_and_guard_required" },
    });
    expect(canvasOperationAdmission(bookmark!)).toEqual({
      courseTarget: { kind: "self_path", resource: "bookmark" },
      write: { state: "held", reason: "self_scope_not_supported" },
    });
  });

  // Section 3.6 of docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md: a bank
  // archive needs an administrator environment flag, a complete dependency preflight, and fresh
  // counts showing zero bank entries and zero uses. Morrow can establish none of those from the
  // routes it has, so this write has no admitted state to reach in any catalog.
  it("never admits an Item Bank archive", () => {
    const archive = catalog.operations.find((operation) => operation.toolName === "canvas_item_bank_archive_bank")!;
    expect(archive.risk).toBe("destructive");
    expect(canvasOperationAdmission(archive).write).toEqual({ state: "held", reason: "item_bank_dependency_review_required" });
    expect(canvasReadbackAssessment(catalog.operations, archive)).toEqual({ state: "not_applicable", reason: "write_held" });
    // A direct course path is the one thing that admits a Canvas write. The Item Bank hold is
    // decided before the course target is read, so even that cannot admit an archive.
    expect(canvasOperationAdmission({ ...archive, path: "/v1/courses/{course_id}/banks/{bank_id}" }).write)
      .toEqual({ state: "held", reason: "item_bank_dependency_review_required" });
  });

  it("holds every self-scoped bookmark and course-nickname write with one plain-language reason", () => {
    const tools = canvasCatalogTools(catalog);
    const selfScoped = [
      "canvas_create_bookmark",
      "canvas_update_bookmark",
      "canvas_delete_bookmark",
      "canvas_set_course_nickname",
      "canvas_remove_course_nickname",
      "canvas_clear_course_nicknames",
    ];
    const reason = "Morrow does not change your personal Canvas bookmarks or course nicknames. It only changes content inside a selected course.";
    for (const name of selfScoped) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name);
      expect(operation, name).toBeTruthy();
      const admission = canvasOperationAdmission(operation!);
      expect(admission.courseTarget.kind, name).toBe("self_path");
      expect(admission.write, name).toEqual({ state: "held", reason: "self_scope_not_supported" });
      expect(canvasReadbackAssessment(catalog.operations, operation!), name).toEqual({ state: "not_applicable", reason: "write_held" });
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.capability?.behavior.supportsReadback, name).toBe(false);
      expect(tool?.capability?.profiles["public-canvas"], name).toEqual({ state: "profile_limited", reason });
      expect(tool?.capability?.evidence?.admission, name).toEqual({ state: "blocked", reason });
    }
  });

  // Account and administrative workflows stay in the product scope, and
  // docs/implementation/CANVAS-ADMISSION-CLASSES.md records the contract they need before admission.
  // Until that contract exists, every route that names an account, the whole Canvas instance, an LTI
  // registration or a developer key is held with its own reason, and none of them is admitted.
  it("holds every account, global, LTI registration and developer key write under one account reason", () => {
    const tools = canvasCatalogTools(catalog);
    const reason = "This change affects a whole Canvas account, not one course. Morrow does not yet have an account permission, so it will not send it.";
    const accountRoute = (path: string) => path.startsWith("/v1/accounts/") || path.startsWith("/lti/accounts/")
      || path.startsWith("/v1/global/") || path.startsWith("/v1/developer_keys/") || path.startsWith("/lti/developer_key/")
      || path.includes("{account_id}");
    const accountWrites = catalog.operations.filter((operation) => !operation.readOnly && accountRoute(operation.path));
    const heldForAccount = catalog.operations.filter((operation) => {
      const write = canvasOperationAdmission(operation).write;
      return write.state === "held" && write.reason === "account_authority_required";
    });
    expect(heldForAccount.map((operation) => operation.toolName).sort())
      .toEqual(accountWrites.map((operation) => operation.toolName).sort());
    expect(accountWrites).toHaveLength(117);

    const byFamily: Record<string, number> = {};
    for (const operation of accountWrites) {
      const family = operation.path.split("/").slice(1, 3).join("/");
      byFamily[family] = (byFamily[family] || 0) + 1;
    }
    expect(byFamily).toEqual({
      "lti/developer_key": 1,
      "v1/account_calendars": 1,
      "v1/accounts": 105,
      "v1/developer_keys": 3,
      "v1/global": 7,
    });

    for (const operation of accountWrites) {
      const name = operation.toolName;
      expect(canvasAccountAuthorityRoute(operation), name).toBe(true);
      expect(canvasReadbackAssessment(catalog.operations, operation), name).toEqual({ state: "not_applicable", reason: "write_held" });
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.capability?.authority.scopeClass, name).toBe("account");
      expect(tool?.capability?.behavior.supportsReadback, name).toBe(false);
      expect(tool?.capability?.profiles["public-canvas"], name).toEqual({ state: "profile_limited", reason });
      expect(tool?.capability?.evidence?.admission, name).toEqual({ state: "blocked", reason });
    }

    // One named route from each part of the class. `canvas_update_courses` changes every course in
    // an account at once, which is exactly the authority a selected course cannot carry.
    expect(accountWrites.map((operation) => operation.toolName)).toEqual(expect.arrayContaining([
      "canvas_create_new_course",
      "canvas_update_courses",
      "canvas_create_lti_registration_lti_registrations",
      "canvas_create_developer_key",
      "canvas_update_developer_key",
      "canvas_update_public_jwk",
      "canvas_create_link_outcome_global",
      "canvas_update_calendar",
    ]));

    // The class is about account authority, not about the letters "lti" in a route. A course-scoped
    // LTI write stays an ordinary admitted course write.
    for (const name of ["canvas_create_line_item", "canvas_create_score", "canvas_update_lti_resource_link"]) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name)!;
      expect(canvasAccountAuthorityRoute(operation), name).toBe(false);
      expect(canvasOperationAdmission(operation).write, name).toEqual({ state: "admitted" });
      expect(tools.find((candidate) => candidate.name === name)?.capability?.authority.scopeClass, name).toBe("course");
    }

    // This class admits nothing. It only names the hold that 117 writes already carried.
    const admitted = catalog.operations.filter((operation) => !operation.readOnly
      && canvasOperationAdmission(operation).write.state === "admitted");
    expect(admitted).toHaveLength(235);
    expect(admitted.filter((operation) => accountRoute(operation.path))).toEqual([]);
    const heldForCourseScope = catalog.operations.filter((operation) => {
      const write = canvasOperationAdmission(operation).write;
      return write.state === "held" && write.reason === "course_scope_required";
    });
    expect(heldForCourseScope).toHaveLength(100);
  });

  it("keeps the single-nickname read bound to one course and produces no other course target kind", () => {
    const read = catalog.operations.find((operation) => operation.toolName === "canvas_get_course_nickname");
    expect(read?.path).toBe("/v1/users/self/course_nicknames/{course_id}");
    expect(canvasOperationAdmission(read!)).toEqual({
      courseTarget: { kind: "self_path", resource: "course_nickname", argument: "course_id" },
      write: { state: "not_applicable" },
    });
    const kinds = new Set(catalog.operations.map((operation) => canvasOperationAdmission(operation).courseTarget.kind));
    expect([...kinds].sort()).toEqual(["course_path", "none", "self_path", "semantic_course_object"]);
    const heldReasons = new Set(catalog.operations
      .map((operation) => canvasOperationAdmission(operation).write)
      .filter((write) => write.state === "held")
      .map((write) => write.reason));
    expect([...heldReasons].sort()).toEqual([
      "account_authority_required",
      "course_scope_required",
      "cross_course_object_requires_resolution",
      "item_bank_account_scope_not_course_scope",
      "item_bank_dependency_review_required",
      "item_bank_fan_out_and_guard_required",
      "learner_scope_requires_separate_authority",
      "multi_step_upload_requires_reviewed_transfer",
      "provider_contract_incomplete",
      "self_scope_not_supported",
    ]);
  });

  // One sentence used to stand for every held write, so the person was told the same thing whether
  // the change named a student's grade, a Canvas account, or a group in another course. This case
  // walks the whole catalog: every held write carries one reason from the closed set, every class
  // has its own sentence, and the published capability shows that sentence to the person.
  it("gives every held write one reason from the closed set and its own plain sentence", () => {
    const tools = canvasCatalogTools(catalog);
    const closedSet = [
      "account_authority_required",
      "course_scope_required",
      "cross_course_object_requires_resolution",
      "item_bank_account_scope_not_course_scope",
      "item_bank_dependency_review_required",
      "item_bank_fan_out_and_guard_required",
      "learner_scope_requires_separate_authority",
      "multi_step_upload_requires_reviewed_transfer",
      "provider_contract_incomplete",
      "self_scope_not_supported",
    ] as const;
    const byReason = new Map<string, string[]>();
    for (const operation of catalog.operations) {
      const write = canvasOperationAdmission(operation).write;
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
      account_authority_required: 117,
      course_scope_required: 100,
      cross_course_object_requires_resolution: 48,
      item_bank_account_scope_not_course_scope: 1,
      item_bank_dependency_review_required: 5,
      item_bank_fan_out_and_guard_required: 1,
      learner_scope_requires_separate_authority: 36,
      multi_step_upload_requires_reviewed_transfer: 4,
      provider_contract_incomplete: 9,
      self_scope_not_supported: 6,
    });
    expect([...byReason.keys()].sort()).toEqual([...closedSet]);

    // No two classes share a sentence, none is empty, and none of them shows the person a route, an
    // internal name, or the word API.
    const sentences = closedSet.map((reason) => canvasAdmissionReason({ state: "held", reason })!);
    expect(new Set(sentences).size).toBe(closedSet.length);
    for (const sentence of sentences) {
      expect(sentence).toMatch(/^[A-Z][^]*\.$/);
      expect(sentence).not.toMatch(/[{}/]|_[a-z]|\bAPI\b/);
    }

    // The two classes this contract adds, named exactly. A Canvas group, file, folder, calendar
    // item or outcome can belong to any course, so its route proves nothing on its own.
    const crossCourseFamilies: Record<string, number> = {};
    for (const name of byReason.get("cross_course_object_requires_resolution")!) {
      const family = catalog.operations.find((operation) => operation.toolName === name)!.path.split("/")[2];
      crossCourseFamilies[family] = (crossCourseFamilies[family] || 0) + 1;
    }
    expect(crossCourseFamilies).toEqual({
      // Creating an appointment group names its courses in the request itself, and nothing proves
      // those are the selected one. The route that changes an existing group is admitted through
      // the reading that says which course it serves.
      appointment_groups: 1,
      files: 2,
      folders: 5,
      group_categories: 3,
      groups: 34,
      outcomes: 1,
      sections: 2,
    });
    expect(byReason.get("provider_contract_incomplete")).toEqual([
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

    // The learner class is no longer only a section route: a quiz attempt, a what-if grade, an
    // originality report on submitted work, group membership and a booked time slot are all one
    // person's own record.
    expect(byReason.get("learner_scope_requires_separate_authority")!.filter((name) => {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name)!;
      return !operation.path.startsWith("/v1/sections/");
    })).toEqual([
      "canvas_answering_questions",
      "canvas_assign_unassigned_members",
      "canvas_bulk_delete_memberships_bulk_deletes_memberships_by_providing_array_of_user_ids_or_for_different",
      "canvas_create_membership",
      "canvas_create_originality_report",
      "canvas_delete_appointment_group",
      "canvas_edit_originality_report_files",
      "canvas_edit_originality_report_submissions",
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

    // The admitted set is pinned here as well. The only writes that ever left it are the four
    // Canvas upload pre-flights, which the case below holds by name.
    expect(catalog.operations.filter((operation) => !operation.readOnly
      && canvasOperationAdmission(operation).write.state === "admitted")).toHaveLength(235);
  });

  // A Canvas file upload is three requests. The catalogued route is only the first one: it asks
  // Canvas where to send the bytes and creates no file. The second request stores the bytes at the
  // address Canvas named and the third confirms the saved file, and Morrow runs those two only
  // inside its reviewed course-file transfer, which freezes the exact file and compares the bytes
  // Canvas saved. Admitting the first step alone would let a caller start an upload Morrow cannot
  // finish, so every course-scoped pre-flight is held and the person is sent to the reviewed
  // transfer instead.
  it("holds every course-scoped Canvas file upload pre-flight and names the reviewed transfer", () => {
    const tools = canvasCatalogTools(catalog);
    const sentence = "Adding a file to Canvas needs Morrow's reviewed file transfer, which checks the file and its saved bytes. Morrow will not start a partial upload.";
    const preflights = catalog.operations.filter((operation) => {
      const write = canvasOperationAdmission(operation).write;
      return write.state === "held" && write.reason === "multi_step_upload_requires_reviewed_transfer";
    });
    expect(preflights.map((operation) => operation.toolName).sort()).toEqual([
      "canvas_upload_file_courses",
      "canvas_upload_file_quiz_id_submissions_self_files_post",
      "canvas_upload_file_submissions_user_id_comments_files_post",
      "canvas_upload_file_v1_courses_course_id_files_post",
    ]);
    for (const operation of preflights) {
      const name = operation.toolName;
      expect(operation.method, name).toBe("POST");
      expect(operation.path, name).toMatch(/^\/v1\/courses\/\{course_id\}\/(?:[^/]+\/)*files$/);
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

    // The same first step outside a course keeps the hold it already had: what those routes lack
    // first is proof of the course, not the rest of the upload.
    expect(catalog.operations.filter((operation) => !operation.readOnly && /files$/.test(operation.path)
      && !preflights.includes(operation))
      .map((operation) => [operation.toolName, String(canvasOperationAdmission(operation).write.reason)])
      .sort((left, right) => left[0].localeCompare(right[0]))).toEqual([
      ["canvas_upload_file_sections", "learner_scope_requires_separate_authority"],
      ["canvas_upload_file_v1_folders_folder_id_files_post", "cross_course_object_requires_resolution"],
      ["canvas_upload_file_v1_groups_group_id_files_post", "cross_course_object_requires_resolution"],
      ["canvas_upload_file_v1_users_user_id_files_post", "course_scope_required"],
    ]);

    // The hold is exactly the upload pre-flight. A course-scoped write on a file that already
    // exists is still an ordinary admitted course write.
    const dateDetails = catalog.operations.find((operation) => operation.toolName === "canvas_update_learning_object_s_date_information_files")!;
    expect(dateDetails.path).toBe("/v1/courses/{course_id}/files/{attachment_id}/date_details");
    expect(canvasOperationAdmission(dateDetails).write).toEqual({ state: "admitted" });

    // The reviewed transfer is not one of these routes and cannot be held by this contract: it is
    // Morrow's own operation, outside the Canvas catalog.
    expect(catalog.operations.some((operation) => operation.toolName === "canvas_transfer_course_file")).toBe(false);
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
        write: { state: "admitted" },
      });
      expect(canvasSemanticCourseTarget(operation), name).toEqual(sectionTarget);
      expect(canvasReadbackAssessment(catalog.operations, operation), name).toEqual({ state: "structurally_exact" });
      const plan = planBrowserReadback(catalog.operations, operation, { id: "302", course_section_name: "Section B" }, { id: "302" });
      expect(plan?.readOperation.toolName, name).toBe("canvas_get_section_information_sections");
      expect(plan?.arguments, name).toEqual({ id: "302" });
      expect(tools.find((tool) => tool.name === name)?.capability?.authority.scopeClass, name).toBe("course");
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
    const byReason = new Map<string, string[]>();
    for (const operation of sectionWrites) {
      const write = canvasOperationAdmission(operation).write;
      const key = write.state === "held" ? write.reason : write.state;
      byReason.set(key, [...(byReason.get(key) || []), operation.toolName].sort());
    }
    expect(byReason.get("admitted")).toEqual(["canvas_delete_section", "canvas_edit_section"]);
    // Cross-listing moves the section into a second course. The reading that proves the first course
    // exists; nothing proves the second, so these two stay with the objects Canvas can move between
    // courses rather than with the routes that name no course at all.
    expect(byReason.get("cross_course_object_requires_resolution")).toEqual(["canvas_cross_list_section", "canvas_de_cross_list_section"]);
    expect(byReason.get("learner_scope_requires_separate_authority")).toHaveLength(17);
    expect([...byReason.keys()].sort()).toEqual(["admitted", "cross_course_object_requires_resolution", "learner_scope_requires_separate_authority"]);
    const learnerReason = "Morrow does not change a student's own record: their submitted work, a quiz attempt, a grade, an enrollment, who is in a group, or a booked time slot. Those need their own permission, so make that change in Canvas.";
    for (const name of byReason.get("learner_scope_requires_separate_authority")!) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool?.capability?.profiles["public-canvas"], name).toEqual({ state: "profile_limited", reason: learnerReason });
      expect(tool?.capability?.behavior.supportsReadback, name).toBe(false);
    }
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
      "canvas_delete_topic_groups",
      "canvas_update_create_front_page_groups",
      "canvas_update_create_page_groups",
      "canvas_update_topic_groups",
    ];
    for (const name of groupContentWrites) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name)!;
      expect(canvasOperationAdmission(operation), name).toEqual({
        courseTarget: { kind: "semantic_course_object", target: groupTarget },
        write: { state: "admitted" },
      });
      expect(canvasSemanticCourseTarget(operation), name).toEqual(groupTarget);
      // The change is read back through the group content route's own GET, inside the same group
      // the reading proved.
      expect(canvasReadbackAssessment(catalog.operations, operation), name).toEqual({ state: "structurally_exact" });
      const plan = planBrowserReadback(catalog.operations, operation, { group_id: "88", topic_id: "9", url_or_id: "week-one", wiki_page_title: "Week one" }, { id: "9", page_id: "9", url: "week-one" });
      expect(plan?.readOperation.path, name).toMatch(/^\/v1\/groups\/\{group_id\}\//);
      expect(plan?.arguments.group_id, name).toBe("88");
      expect(tools.find((tool) => tool.name === name)?.capability?.authority.scopeClass, name).toBe("course");
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
    const byReason = new Map<string, string[]>();
    for (const operation of groupWrites) {
      const write = canvasOperationAdmission(operation).write;
      const key = write.state === "held" ? write.reason : write.state;
      byReason.set(key, [...(byReason.get(key) || []), operation.toolName].sort());
    }
    expect([...byReason.keys()].sort()).toEqual(["admitted", "cross_course_object_requires_resolution", "learner_scope_requires_separate_authority"]);
    expect(byReason.get("admitted")).toEqual(groupContentWrites);
    // Every route whose purpose is to place, move, or remove people.
    expect(byReason.get("learner_scope_requires_separate_authority")).toEqual([
      "canvas_assign_unassigned_members",
      "canvas_bulk_delete_memberships_bulk_deletes_memberships_by_providing_array_of_user_ids_or_for_different",
      "canvas_create_membership",
      "canvas_import_category_groups",
      "canvas_invite_others_to_group",
      "canvas_leave_group_memberships",
      "canvas_leave_group_users",
      "canvas_update_membership_memberships",
      "canvas_update_membership_users",
    ]);
    // No group set is admitted. Changing one can create groups and place students in them, and
    // deleting one removes every group in it, so a group set keeps the hold its object family has.
    for (const name of ["canvas_create_group_group_categories", "canvas_delete_group_category", "canvas_update_group_category"]) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name)!;
      expect(canvasOperationAdmission(operation).write, name).toEqual({ state: "held", reason: "cross_course_object_requires_resolution" });
      expect(canvasSemanticCourseTarget(operation), name).toBeUndefined();
    }
    // A group's own object and its files stay held as well: the file routes belong to the reviewed
    // file contract, and the group object itself has no declared reading yet.
    for (const name of ["canvas_delete_group", "canvas_edit_group", "canvas_set_usage_rights_groups", "canvas_upload_file_v1_groups_group_id_files_post"]) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name)!;
      expect(canvasOperationAdmission(operation).write, name).toEqual({ state: "held", reason: "cross_course_object_requires_resolution" });
    }
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
        write: { state: "admitted" },
      });
      expect(canvasReadbackAssessment(catalog.operations, operation), name).toEqual({ state: "structurally_exact" });
      const plan = planBrowserReadback(catalog.operations, operation, { id: "601", name: "Syllabus 2026.pdf" }, { id: "601" });
      expect(plan?.readOperation.toolName, name).toBe("canvas_get_file_files");
      expect(plan?.arguments, name).toEqual({ id: "601" });
      expect(tools.find((tool) => tool.name === name)?.capability?.authority.scopeClass, name).toBe("course");
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
    // other file or folder write has no reading declared for it at all.
    const fileWrites = catalog.operations.filter((operation) => !operation.readOnly && /^\/v1\/(?:files|folders)(?:\/|$)/.test(operation.path));
    expect(fileWrites).toHaveLength(10);
    const byReason = new Map<string, string[]>();
    for (const operation of fileWrites) {
      const write = canvasOperationAdmission(operation).write;
      const key = write.state === "held" ? write.reason : write.state;
      byReason.set(key, [...(byReason.get(key) || []), operation.toolName].sort());
    }
    expect([...byReason.keys()].sort()).toEqual(["admitted", "cross_course_object_requires_resolution"]);
    expect(byReason.get("admitted")).toEqual(["canvas_create_folder_folders", "canvas_delete_file", "canvas_update_file"]);
    expect(byReason.get("cross_course_object_requires_resolution")).toEqual([
      "canvas_copy_file",
      "canvas_copy_folder",
      "canvas_delete_folder",
      "canvas_reset_link_verifier",
      "canvas_update_folder",
      "canvas_update_word_count",
      "canvas_upload_file_v1_folders_folder_id_files_post",
    ]);
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
      expect(tools.find((tool) => tool.name === name)?.capability?.authority.scopeClass, name).toBe("course");
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

    // Booking a slot and cancelling a whole sign-up sheet are a person's own record, and creating a
    // sign-up sheet names its courses in the request itself, which nothing proves.
    for (const [name, reason] of [
      ["canvas_reserve_time_slot", "learner_scope_requires_separate_authority"],
      ["canvas_reserve_time_slot_participant_id", "learner_scope_requires_separate_authority"],
      ["canvas_delete_appointment_group", "learner_scope_requires_separate_authority"],
      ["canvas_create_appointment_group", "cross_course_object_requires_resolution"],
      ["canvas_save_enabled_account_calendars", "course_scope_required"],
    ]) {
      const operation = catalog.operations.find((candidate) => candidate.toolName === name)!;
      expect(canvasOperationAdmission(operation).write, name).toEqual({ state: "held", reason });
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
    expect(assessments.filter((assessment) => assessment.state === "unavailable")).toHaveLength(63);
    expect(assessments.filter((assessment) => assessment.state === "blocked")).toHaveLength(23);
    expect(assessments.filter((assessment) => assessment.state === "unconfirmed")).toHaveLength(0);
    expect(admittedWrites).toHaveLength(235);
    expect(assessments.filter((assessment) => assessment.state === "structurally_exact")).toHaveLength(149);
    const tools = canvasCatalogTools(catalog);
    expect(tools.find((tool) => tool.name === "canvas_update_custom_gradebook_column")?.capability?.behavior.supportsReadback).toBe(true);
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
    expect(tools.find((tool) => tool.name === "canvas_unlink_outcome_courses")?.capability?.behavior.supportsReadback).toBe(true);
    expect(tools.find((tool) => tool.name === "canvas_bulk_update_assignment_dates")?.capability?.behavior.supportsReadback).toBe(true);
    expect(tools.find((tool) => tool.name === "canvas_re_activate_enrollment")?.capability?.behavior.supportsReadback).toBe(true);
    expect(tools.find((tool) => tool.name === "canvas_disable_assignments_currently_enabled_for_grade_export_to_sis")?.capability?.behavior.supportsReadback).toBe(false);
    expect(tools.find((tool) => tool.name === "canvas_set_course_level_accommodations")?.capability?.evidence?.readback).toMatchObject({ state: "blocked" });
  });

  it("refuses a readback whose read route is not the write target's own resource", () => {
    const tools = canvasCatalogTools(catalog);
    const withoutSafeRoute = [
      "canvas_reset_course",
      "canvas_grade_or_comment_on_multiple_submissions_courses_submissions",
      "canvas_create_score",
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
    const update = catalog.operations.find((operation) => operation.toolName === "canvas_update_course");
    expect(update).toBeTruthy();
    const withoutCanvasReads = catalog.operations.filter((operation) => !operation.readOnly || operation.service !== "canvas");
    expect(canvasReadbackAssessment(withoutCanvasReads, update!)).toEqual({
      state: "unavailable",
      reason: "no_safe_readback_route",
    });
  });
});
