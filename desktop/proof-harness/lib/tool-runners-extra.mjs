// The controls the first pass had no exercise for: batches, the planners, and the rest. Each is
// given something this run made, so nothing the course already held is altered.
export function extraRunners({ COURSE, SOURCE_BINDING, mark, state, callTool, read, change, plan }) {
  const answered = (value) => Boolean(value) && value.isError !== true
    && (value.structuredContent !== undefined || (value.content ?? []).length > 0);

  /** One disposable New Quiz for the quiz planners to work on, made once and reused. */
  const proofQuiz = async () => {
    if (state.quizId) return state.quizId;
    const title = `${mark} planner quiz`;
    const made = await plan("tools.quiz.create", "morrow_plan_new_quiz_create", { course_id: COURSE, quiz: { title } });
    if (made.outcome !== "verified") return null;
    const quizzes = await read("canvas_list_new_quizzes", { course_id: COURSE });
    const saved = (Array.isArray(quizzes.data) ? quizzes.data : []).find((row) => String(row.title) === title);
    state.quizId = saved ? String(saved.id) : null;
    return state.quizId;
  };

  const plannerOnQuiz = (label, tool, args) => async () => {
    const quizId = await proofQuiz();
    if (!quizId) return { blocked: "This run could not create a quiz for the planners to work on." };
    const made = await plan(label, tool, typeof args === "function" ? await args(quizId) : { course_id: COURSE, quiz_id: quizId, ...args });
    return { ok: made.outcome === "verified", detail: { outcome: made.outcome, quizId } };
  };

  return {
    // Batches, over reads that change nothing.
    morrow_batch_create: async () => {
      // A read-only batch: it lists things and changes nothing, so running it proves the batch
      // machinery without putting the course at risk.
      const answer = await callTool("morrow_batch_create", {
        name: `${mark} batch`,
        mode: "read_only",
        operation_family: "canvas_reads",
        profile_digest: "a".repeat(64),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        operations: [
          { child_id: "modules", tool: "canvas_list_modules", course_id: COURSE, arguments: { course_id: COURSE }, source_binding_id: SOURCE_BINDING },
          { child_id: "groups", tool: "canvas_list_assignment_groups", course_id: COURSE, arguments: { course_id: COURSE }, source_binding_id: SOURCE_BINDING },
        ],
      }, 600_000);
      const held = answer?.structuredContent ?? {};
      state.batchId = held.batch?.batchId ?? held.batchId ?? null;
      return { ok: answered(answer) && Boolean(state.batchId), answer, detail: { batchId: state.batchId, mode: "read_only" } };
    },
    morrow_batch_get: async () => state.batchId
      ? { answer: await callTool("morrow_batch_get", { batch_id: state.batchId }) }
      : { blocked: "This run made no batch to read." },
    morrow_batch_run: async () => state.batchId
      ? { answer: await callTool("morrow_batch_run", { batch_id: state.batchId }, 900_000) }
      : { blocked: "This run made no batch to run." },
    morrow_batch_pause: async () => state.batchId
      ? { answer: await callTool("morrow_batch_pause", { batch_id: state.batchId }) }
      : { blocked: "This run made no batch to pause." },
    morrow_batch_resume: async () => state.batchId
      ? { answer: await callTool("morrow_batch_resume", { batch_id: state.batchId }) }
      : { blocked: "This run made no batch to resume." },
    morrow_batch_reconcile: async () => state.batchId
      ? { answer: await callTool("morrow_batch_reconcile", { batch_id: state.batchId }, 600_000) }
      : { blocked: "This run made no batch to reconcile." },
    morrow_batch_recover: async () => state.batchId
      ? { answer: await callTool("morrow_batch_recover", { batch_id: state.batchId }, 600_000) }
      : { blocked: "This run made no batch to recover." },
    morrow_batch_results_page: async () => state.batchId
      ? { answer: await callTool("morrow_batch_results_page", { batch_id: state.batchId, offset: 0, limit: 10 }) }
      : { blocked: "This run made no batch to read results from." },
    morrow_batch_cancel: async () => state.batchId
      ? { answer: await callTool("morrow_batch_cancel", { batch_id: state.batchId }) }
      : { blocked: "This run made no batch to cancel." },

    // The rest of the controls.
    morrow_profile_status: async () => ({ answer: await callTool("morrow_profile_status", {}) }),
    morrow_program_ledger: async () => ({
      blocked: "The ledger control takes an inventory record this harness does not build; it is recorded unproven rather than assumed.",
    }),
    morrow_request_edit_access: async () => {
      // Asking in plan mode shows what an Edit grant would cover without granting anything.
      const answer = await callTool("morrow_request_edit_access", {
        mode: "plan",
        // Plan mode names only the connection: it answers what an Edit grant would cover, and
        // naming categories is how a grant is actually made, which this harness never does.
        selections: [{ source_binding_id: SOURCE_BINDING }],
      }, 300_000);
      return { ok: answered(answer), answer, detail: { mode: "plan", grantedNothing: true } };
    },
    morrow_result_page: async () => {
      // A large read answers with a handle; reading that handle is the control under proof.
      const listed = await callTool("morrow_capability_read", {
        name: "canvas_list_assignments_assignments",
        arguments: { course_id: COURSE, morrow_max_pages: 10, _morrow: { source_binding_id: SOURCE_BINDING } },
      }, 600_000);
      const handle = listed?.structuredContent?.data?.handle ?? listed?.structuredContent?.handle;
      if (!handle) return { blocked: "The read answered inline, so there is no result handle to page through." };
      return { answer: await callTool("morrow_result_page", { handle, offset: 0, limit: 4000 }) };
    },
    morrow_read_item_bank_fan_out: async () => {
      const banks = await callTool("morrow_capability_read", {
        name: "canvas_item_bank_list_banks",
        arguments: { course_id: COURSE, _morrow: { source_binding_id: SOURCE_BINDING } },
      }, 600_000);
      const held = banks?.structuredContent?.data ?? {};
      const rows = held?.result?.data ?? held?.data ?? [];
      const first = Array.isArray(rows) ? rows[0] : null;
      if (!first) return { blocked: "The sandbox course holds no item bank to read the reach of." };
      return { answer: await callTool("morrow_read_item_bank_fan_out", {
        source_binding_id: SOURCE_BINDING, course_id: COURSE, bank_id: String(first.id), quiz_use_course_ids: [COURSE],
      }, 900_000) };
    },

    // The remaining New Quiz planners, on the quiz this run makes.
    morrow_plan_new_quiz_item_delete: async () => {
      const quizId = await proofQuiz();
      if (!quizId) return { blocked: "This run could not create a quiz to delete a question from." };
      await plan("tools.quiz.item.for-delete", "morrow_plan_new_quiz_item_create", {
        course_id: COURSE, quiz_id: quizId,
        item: { entry_type: "Item", points_possible: 1, entry: { title: "question to remove", item_body: "<p>Remove me.</p>",
          interaction_type_slug: "true-false", calculator_type: "none",
          interaction_data: { true_choice: "True", false_choice: "False" }, scoring_data: { value: true }, scoring_algorithm: "Equivalence" } },
      });
      const items = await callTool("morrow_capability_read", { name: "canvas_list_quiz_items",
        arguments: { course_id: COURSE, assignment_id: quizId, _morrow: { source_binding_id: SOURCE_BINDING } } }, 300_000);
      const held = items?.structuredContent?.data ?? {};
      const rows = held?.result?.data ?? held?.data ?? [];
      const target = (Array.isArray(rows) ? rows : []).find((row) => String(row?.entry?.title) === "question to remove");
      if (!target) return { blocked: "The question this run added could not be found to remove." };
      const made = await plan("tools.quiz.item.delete", "morrow_plan_new_quiz_item_delete", { course_id: COURSE, quiz_id: quizId, item_id: String(target.id) });
      return { ok: made.outcome === "verified", detail: { outcome: made.outcome } };
    },
    morrow_plan_new_quiz_item_order: async () => {
      const quizId = await proofQuiz();
      if (!quizId) return { blocked: "This run could not create a quiz to order questions in." };
      const items = await callTool("morrow_capability_read", { name: "canvas_list_quiz_items",
        arguments: { course_id: COURSE, assignment_id: quizId, _morrow: { source_binding_id: SOURCE_BINDING } } }, 300_000);
      const held = items?.structuredContent?.data ?? {};
      const rows = held?.result?.data ?? held?.data ?? [];
      if (!Array.isArray(rows) || rows.length < 2) return { blocked: "The quiz holds fewer than two questions, so there is no order to change." };
      const order = [...rows].reverse().map((row) => String(row.id));
      const made = await plan("tools.quiz.item.order", "morrow_plan_new_quiz_item_order", { course_id: COURSE, quiz_id: quizId, item_ids: order });
      return { ok: made.outcome === "verified", detail: { outcome: made.outcome, questions: order.length } };
    },
    morrow_plan_new_quiz_module_move: async () => {
      const quizId = await proofQuiz();
      if (!quizId || !state.moduleId) return { blocked: "This run has no quiz placed in a module to move." };
      const made = await plan("tools.quiz.module.move", "morrow_plan_new_quiz_module_move", {
        course_id: COURSE, quiz_id: quizId, module_id: state.moduleId, position: 1,
      });
      return { ok: made.outcome === "verified", detail: { outcome: made.outcome } };
    },
    morrow_plan_new_quiz_assignment_group_order: async () => {
      const quizId = await proofQuiz();
      const groups = await read("canvas_list_assignment_groups", { course_id: COURSE });
      const group = (Array.isArray(groups.data) ? groups.data : [])[0];
      if (!quizId || !group) return { blocked: "This run has no quiz, or the course holds no assignment group." };
      const made = await plan("tools.quiz.group.order", "morrow_plan_new_quiz_assignment_group_order", {
        course_id: COURSE, quiz_id: quizId, assignment_group_id: String(group.id), position: 1,
      });
      return { ok: made.outcome === "verified", detail: { outcome: made.outcome } };
    },

    // The New Quiz planners, on a quiz this run makes.
    morrow_plan_new_quiz_create: async () => {
      const quizId = await proofQuiz();
      return quizId
        ? { ok: true, detail: { quizId, evidence: "Canvas lists the quiz this planner created" } }
        : { blocked: "The quiz planner did not create a quiz." };
    },
    morrow_plan_new_quiz_settings: plannerOnQuiz("tools.quiz.settings", "morrow_plan_new_quiz_settings", { settings: { shuffle_questions: true } }),
    morrow_plan_new_quiz_item_create: plannerOnQuiz("tools.quiz.item.create", "morrow_plan_new_quiz_item_create", {
      item: { entry_type: "Item", points_possible: 1, entry: { title: "planner question", item_body: "<p>Which one?</p>",
        interaction_type_slug: "true-false", calculator_type: "none",
        interaction_data: { true_choice: "True", false_choice: "False" }, scoring_data: { value: true }, scoring_algorithm: "Equivalence" } },
    }),
    morrow_plan_new_quiz_report: plannerOnQuiz("tools.quiz.report", "morrow_plan_new_quiz_report", { report_type: "student_analysis", format: "json" }),
    morrow_plan_new_quiz_module_placement: async () => {
      const quizId = await proofQuiz();
      const modules = await read("canvas_list_modules", { course_id: COURSE });
      const module = (Array.isArray(modules.data) ? modules.data : [])[0];
      if (!quizId || !module) return { blocked: "This run has no quiz, or the course holds no module to place it in." };
      const made = await plan("tools.quiz.placement", "morrow_plan_new_quiz_module_placement", {
        course_id: COURSE, quiz_id: quizId, module_id: String(module.id), position: 1,
      });
      state.moduleId = String(module.id);
      return { ok: made.outcome === "verified", detail: { outcome: made.outcome, moduleId: state.moduleId } };
    },
    morrow_plan_new_quiz_delete: async () => {
      const quizId = await proofQuiz();
      if (!quizId) return { blocked: "This run has no quiz to delete." };
      const made = await plan("tools.quiz.delete", "morrow_plan_new_quiz_delete", { course_id: COURSE, quiz_id: quizId });
      if (made.outcome === "verified") state.quizId = null;
      // Canvas is asked whether the quiz is gone.
      const quizzes = await read("canvas_list_new_quizzes", { course_id: COURSE });
      const still = (Array.isArray(quizzes.data) ? quizzes.data : []).some((row) => String(row.id) === quizId);
      return { ok: made.outcome === "verified" && !still, detail: { outcome: made.outcome, stillInCanvas: still } };
    },
  };
}
