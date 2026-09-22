import { describe, expect, it } from "vitest";
import {
  MOODLE_QUESTION_BANK_IMPACT_SCOPE_SCHEMA,
  projectMoodleQuestionBankImpactScope,
} from "../src/moodle-question-impact.js";

const PROOF = {
  method: "core_courseformat_get_state",
  slot_source: "mod_quiz_edit_page",
  required_capability: "mod/quiz:manage",
  scope: "approved_course_only",
  cross_course_references: "not_enumerated",
  condition_class_resolution: "not_exposed",
  plugin_components: "not_exposed",
  recognised_filter_keys: ["category"],
  quiz_limit: 50,
  slot_limit_per_quiz: 100,
  reason_limit: 200,
  question_bank_write_eligibility: "held",
};

// These literals are the exact browser output asserted in
// scripts/test/moodle-question-impact-read.test.mjs. Keep the two in step.
const directSlot = {
  slot_id: 17,
  position: 1,
  reference: "direct",
  resolved: true,
  question_id: 401,
  version: { mode: "latest" },
};

const randomSlot = {
  slot_id: 18,
  position: 2,
  reference: "random",
  resolved: true,
  questions_context_id: 42,
  filter_source: "quiz_edit_slot_data",
  filter_jointype: 2,
  filter_jointype_name: "all",
  filters: [{ key: "category", jointype: 1, jointype_name: "any", values: ["17"], recognised: true, include_subcategories: true }],
};

const scope = (overrides: Record<string, unknown> = {}, slots: unknown[] = [directSlot, randomSlot], reasons: unknown[] = []) => ({
  schema: MOODLE_QUESTION_BANK_IMPACT_SCOPE_SCHEMA,
  provider: "moodle",
  course_id: 2,
  status: reasons.length ? "impact_scope_incomplete" : "complete",
  quiz_count: 1,
  slot_count: slots.length,
  direct_reference_count: slots.filter((entry) => (entry as { reference: string }).reference === "direct").length,
  random_reference_count: slots.filter((entry) => (entry as { reference: string }).reference === "random").length,
  quizzes: [{ module_id: 9, name: "Unit 1 Quiz", slot_count: slots.length, slots_readable: true, slots }],
  incomplete_reasons: reasons,
  incomplete_reasons_truncated: false,
  proof: PROOF,
  ...overrides,
});

describe("Moodle Question Bank impact-scope projection", () => {
  it("keeps one direct and one random stored reference and reports a complete scope", () => {
    const result = projectMoodleQuestionBankImpactScope(scope(), { courseId: 2 });
    expect(result.status).toBe("complete");
    expect(result.direct_reference_count).toBe(1);
    expect(result.random_reference_count).toBe(1);
    expect(result.quizzes[0]?.slots).toEqual([directSlot, randomSlot]);
    expect(result.proof.question_bank_write_eligibility).toBe("held");
    expect(result.proof.condition_class_resolution).toBe("not_exposed");
    expect(result.proof.plugin_components).toBe("not_exposed");
    expect(result.proof.cross_course_references).toBe("not_enumerated");
  });

  it("refuses a scope for a course other than the approved one", () => {
    expect(() => projectMoodleQuestionBankImpactScope(scope(), { courseId: 3 }))
      .toThrow("moodle_question_bank_impact_scope_invalid");
  });

  it("refuses a complete status when a stored filter key is outside the recognised set", () => {
    const unknownFilter = {
      ...randomSlot,
      filters: [{ key: "qbank_customfilter", jointype: 1, jointype_name: "any", values: ["7"], recognised: false }],
    };
    expect(() => projectMoodleQuestionBankImpactScope(scope({}, [directSlot, unknownFilter]), { courseId: 2 }))
      .toThrow("moodle_question_bank_impact_scope_invalid");
    const reported = projectMoodleQuestionBankImpactScope(
      scope({}, [directSlot, unknownFilter], [{ reason: "filter_class_unrecognised", module_id: 9, slot_id: 18, filter_key: "qbank_customfilter" }]),
      { courseId: 2 },
    );
    expect(reported.status).toBe("impact_scope_incomplete");
  });

  it("refuses a filter that claims an unrecognised key is one Morrow recognises", () => {
    const claimed = { ...randomSlot, filters: [{ key: "qbank_customfilter", jointype: 1, jointype_name: "any", values: ["7"], recognised: true }] };
    expect(() => projectMoodleQuestionBankImpactScope(scope({}, [directSlot, claimed], [{ reason: "filter_class_unrecognised" }]), { courseId: 2 }))
      .toThrow("moodle_question_bank_impact_scope_invalid");
  });

  it("refuses a complete status when a filter or its condition uses jointype NONE", () => {
    const noneFilter = {
      ...randomSlot,
      filters: [{ key: "category", jointype: 0, jointype_name: "none", values: ["17"], recognised: true }],
    };
    expect(() => projectMoodleQuestionBankImpactScope(scope({}, [directSlot, noneFilter]), { courseId: 2 }))
      .toThrow("moodle_question_bank_impact_scope_invalid");
    const noneCondition = { ...randomSlot, filter_jointype: 0, filter_jointype_name: "none" };
    expect(() => projectMoodleQuestionBankImpactScope(scope({}, [directSlot, noneCondition]), { courseId: 2 }))
      .toThrow("moodle_question_bank_impact_scope_invalid");
    const reported = projectMoodleQuestionBankImpactScope(
      scope({}, [directSlot, noneFilter], [{ reason: "filter_jointype_none", module_id: 9, slot_id: 18, filter_key: "category" }]),
      { courseId: 2 },
    );
    expect(reported.status).toBe("impact_scope_incomplete");
  });

  it("refuses a complete status when a reference or a slot list could not be read", () => {
    const unresolvedDirect = { slot_id: 17, position: 1, reference: "direct", resolved: false };
    expect(() => projectMoodleQuestionBankImpactScope(scope({}, [unresolvedDirect, randomSlot]), { courseId: 2 }))
      .toThrow("moodle_question_bank_impact_scope_invalid");
    const notExposed = { slot_id: 18, position: 2, reference: "random", resolved: false };
    expect(() => projectMoodleQuestionBankImpactScope(scope({}, [directSlot, notExposed]), { courseId: 2 }))
      .toThrow("moodle_question_bank_impact_scope_invalid");
    const missingContext = { ...randomSlot, resolved: false, questions_context_id: null };
    expect(() => projectMoodleQuestionBankImpactScope(scope({}, [directSlot, missingContext]), { courseId: 2 }))
      .toThrow("moodle_question_bank_impact_scope_invalid");
    const truncatedQuiz = projectMoodleQuestionBankImpactScope({
      ...scope({}, [], [{ reason: "slot_list_truncated", module_id: 9 }]),
      quizzes: [{ module_id: 9, slot_count: 0, slots_readable: false, slots: [] }],
    }, { courseId: 2 });
    expect(truncatedQuiz.status).toBe("impact_scope_incomplete");
    expect(truncatedQuiz.quizzes[0]?.slots_readable).toBe(false);
  });

  it("keeps the parsed filters of a random slot whose questions context was not exposed", () => {
    const missingContext = { ...randomSlot, resolved: false, questions_context_id: null };
    const result = projectMoodleQuestionBankImpactScope(
      scope({}, [directSlot, missingContext], [{ reason: "random_context_not_exposed", module_id: 9, slot_id: 18 }]),
      { courseId: 2 },
    );
    expect(result.status).toBe("impact_scope_incomplete");
    expect(result.quizzes[0]?.slots[1]).toEqual(missingContext);
  });

  it("refuses malformed counts, positions, identifiers, filter values and reason codes", () => {
    for (const broken of [
      scope({ slot_count: 3 }),
      scope({ quiz_count: 2 }),
      scope({ direct_reference_count: 2 }),
      scope({ proof: { ...PROOF, question_bank_write_eligibility: "eligible" } }),
      scope({ proof: { ...PROOF, recognised_filter_keys: ["category", "qtagids"] } }),
      scope({}, [directSlot, { ...randomSlot, position: 5 }]),
      scope({}, [directSlot, { ...randomSlot, slot_id: 17 }]),
      scope({}, [directSlot, { ...randomSlot, filters: [{ ...randomSlot.filters[0], values: ["17 OR 1=1"] }] }]),
      scope({}, [directSlot, { ...randomSlot, filters: [{ ...randomSlot.filters[0], jointype_name: "all" }] }]),
      scope({}, [directSlot, { ...randomSlot, filters: [] }]),
      scope({}, [{ ...directSlot, version: { mode: "pinned" } }, randomSlot]),
      scope({}, [directSlot, randomSlot], [{ reason: "filter_plugin_trusted" }]),
      scope({}, [directSlot, randomSlot], [{ reason: "filter_jointype_none", note: "extra" }]),
    ]) {
      expect(() => projectMoodleQuestionBankImpactScope(broken, { courseId: 2 }), JSON.stringify(broken).slice(0, 120))
        .toThrow("moodle_question_bank_impact_scope_invalid");
    }
  });
});
