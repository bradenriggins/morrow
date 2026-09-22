import { describe, expect, it } from "vitest";
import {
  MOODLE_CHOICE_OPTIONS_SCHEMA,
  MOODLE_CHOICE_RESPONSE_SUMMARY_SCHEMA,
  MOODLE_DATABASE_ENTRY_SUMMARY_SCHEMA,
  MOODLE_DATABASE_FIELDS_SCHEMA,
  MOODLE_FEEDBACK_ITEMS_SCHEMA,
  MOODLE_FEEDBACK_RESPONSE_SUMMARY_SCHEMA,
  moodleActivityContentReadByTool,
  projectMoodleChoiceOptions,
  projectMoodleChoiceResponseSummary,
  projectMoodleDatabaseEntrySummary,
  projectMoodleDatabaseFields,
  projectMoodleFeedbackItems,
  projectMoodleFeedbackResponseSummary,
} from "../src/moodle-activity-content.js";

const target = { courseId: 2, moduleId: 8 };

const choiceOptions = {
  schema: MOODLE_CHOICE_OPTIONS_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  choice_id: 21,
  option_count: 2,
  options: [
    { option_id: 41, position: 1, text: "Morning lab", response_limit: 12 },
    { option_id: 42, position: 2, text: "Evening lab", response_limit: 0 },
  ],
  limit_answers: true,
  allow_multiple: false,
  has_responses: false,
  proof: {
    method: "course_modedit_form",
    complete: true,
    exact_module_binding: "course_modedit_form",
    required_capability: "moodle/course:manageactivities",
    option_limit: 100,
    option_rows: 2,
    text_limit: 4000,
  },
};

const choiceSummary = {
  schema: MOODLE_CHOICE_RESPONSE_SUMMARY_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  choice_id: 21,
  responded_participant_count: 2,
  allow_multiple: false,
  proof: {
    method: "course_modedit_form+core_courseformat_get_overview_information",
    complete: true,
    exact_module_binding: "course_modedit_form",
    required_capability: "mod/choice:readresponses",
    activity_limit: 500,
    activity_rows: 2,
    overview_item_key: "studentwhoresponded",
  },
};

const feedbackItems = {
  schema: MOODLE_FEEDBACK_ITEMS_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  feedback_id: 22,
  anonymous: true,
  item_count: 2,
  items: [
    {
      item_id: 501, position: 1, type: "multichoice", required: true,
      text: "How clear was the lab brief?", label: "clarity", presentation: "r>>>>>Very clear|Clear|Unclear",
      depends_on_item_id: null, depends_on_value: "",
    },
    {
      item_id: 502, position: 2, type: "textarea", required: false,
      text: "What would you change?", label: "changes", presentation: "30|5",
      depends_on_item_id: 501, depends_on_value: "Unclear",
    },
  ],
  proof: {
    method: "course_modedit_form+mod_feedback_export_items",
    complete: true,
    exact_module_binding: "course_modedit_form",
    required_capability: "mod/feedback:edititems",
    item_limit: 200,
    item_rows: 2,
    text_limit: 4000,
  },
};

const feedbackSummary = {
  schema: MOODLE_FEEDBACK_RESPONSE_SUMMARY_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  feedback_id: 22,
  anonymous: true,
  response_count: 5,
  per_learner_projection: "refused_anonymous",
  proof: {
    method: "course_modedit_form+core_courseformat_get_overview_information",
    complete: true,
    exact_module_binding: "course_modedit_form",
    required_capability: "mod/feedback:viewreports",
    activity_limit: 500,
    activity_rows: 2,
    overview_item_key: "responses",
  },
};

const databaseFields = {
  schema: MOODLE_DATABASE_FIELDS_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  database_id: 31,
  field_count: 2,
  default_sort_field_id: 72,
  fields: [{ field_id: 71, name: "Species", type: "text" }, { field_id: 72, name: "Habitat", type: "menu" }],
  proof: {
    method: "course_modedit_form+mod_data_field_index",
    complete: true,
    exact_module_binding: "course_modedit_form",
    required_capability: "mod/data:managetemplates",
    field_limit: 100,
    field_rows: 2,
    text_limit: 4000,
  },
};

const databaseEntrySummary = {
  schema: MOODLE_DATABASE_ENTRY_SUMMARY_SCHEMA,
  provider: "moodle",
  course_id: 2,
  module_id: 8,
  database_id: 31,
  entry_count: 7,
  entries_awaiting_approval: 2,
  comment_count: 3,
  approval_required: true,
  proof: {
    method: "course_modedit_form+core_courseformat_get_overview_information",
    complete: true,
    exact_module_binding: "course_modedit_form",
    required_capability: "mod/data:approve",
    activity_limit: 500,
    activity_rows: 2,
    overview_item_key: "totalentries",
  },
};

describe("Moodle Choice, Feedback and Database child-record projections", () => {
  it("keeps only the declared fields when the browser adds learner rows", () => {
    const options = projectMoodleChoiceOptions({
      ...choiceOptions,
      respondents: [{ id: 7, fullname: "Jane Moodle", chosen_option: 41 }],
      options: choiceOptions.options.map((option) => ({ ...option, chosen_by: ["Jane Moodle"] })),
    }, target);
    expect(options).toEqual(choiceOptions);
    const summary = projectMoodleChoiceResponseSummary({
      ...choiceSummary,
      raw_rows: [{ userid: 7, email: "jane@example.edu" }],
    }, target);
    expect(summary).toEqual(choiceSummary);
    const entries = projectMoodleDatabaseEntrySummary({
      ...databaseEntrySummary,
      raw_entries: [{ id: 91, userid: 7, fullname: "Jane Moodle" }],
    }, target);
    expect(entries).toEqual(databaseEntrySummary);
    for (const value of [options, summary, entries]) {
      expect(JSON.stringify(value)).not.toContain("Jane Moodle");
      expect(JSON.stringify(value)).not.toContain("jane@example.edu");
    }
  });

  it("projects the Feedback item list and the aggregate response counts", () => {
    expect(projectMoodleFeedbackItems(feedbackItems, target)).toEqual(feedbackItems);
    expect(projectMoodleFeedbackResponseSummary(feedbackSummary, target)).toEqual(feedbackSummary);
    expect(projectMoodleDatabaseFields(databaseFields, target)).toEqual(databaseFields);
    expect(projectMoodleFeedbackResponseSummary({
      ...feedbackSummary, anonymous: false, per_learner_projection: "not_supported",
    }, target)).toMatchObject({ anonymous: false, per_learner_projection: "not_supported", response_count: 5 });
  });

  it("refuses a per-learner projection of an anonymous Feedback by name", () => {
    expect(() => projectMoodleFeedbackResponseSummary({
      ...feedbackSummary,
      respondents: [{ id: 7, fullname: "Jane Moodle" }],
    }, target)).toThrow("moodle_feedback_response_summary_anonymous_refused");
    expect(() => projectMoodleFeedbackResponseSummary({
      ...feedbackSummary,
      learner: { user_id: "7" },
    }, target)).toThrow("moodle_feedback_response_summary_anonymous_refused");
    expect(() => projectMoodleFeedbackResponseSummary({
      ...feedbackSummary,
      per_learner_projection: "not_supported",
    }, target)).toThrow("moodle_feedback_response_summary_anonymous_refused");
    // A named Feedback still has no per-learner projection here; the extra rows
    // are dropped rather than returned.
    expect(projectMoodleFeedbackResponseSummary({
      ...feedbackSummary,
      anonymous: false,
      per_learner_projection: "not_supported",
      respondents: [{ id: 7, fullname: "Jane Moodle" }],
    }, target)).toEqual({ ...feedbackSummary, anonymous: false, per_learner_projection: "not_supported" });
  });

  it("refuses a changed scope, a broken proof, and an inconsistent count", () => {
    expect(() => projectMoodleChoiceOptions({ ...choiceOptions, module_id: 9 }, target))
      .toThrow("moodle_choice_options_invalid");
    expect(() => projectMoodleChoiceOptions({ ...choiceOptions, option_count: 3 }, target))
      .toThrow("moodle_choice_options_invalid");
    expect(() => projectMoodleChoiceOptions({
      ...choiceOptions,
      options: [choiceOptions.options[1], choiceOptions.options[0]],
    }, target)).toThrow("moodle_choice_options_invalid");
    expect(() => projectMoodleChoiceResponseSummary({
      ...choiceSummary, proof: { ...choiceSummary.proof, required_capability: "mod/choice:view" },
    }, target)).toThrow("moodle_choice_response_summary_invalid");
    expect(() => projectMoodleChoiceResponseSummary({
      ...choiceSummary, proof: { ...choiceSummary.proof, complete: false },
    }, target)).toThrow("moodle_choice_response_summary_invalid");
    expect(() => projectMoodleFeedbackItems({
      ...feedbackItems, items: [{ ...feedbackItems.items[0], depends_on_item_id: 0 }], item_count: 1,
    }, target)).toThrow("moodle_feedback_items_invalid");
    expect(() => projectMoodleDatabaseFields({ ...databaseFields, default_sort_field_id: 99 }, target))
      .toThrow("moodle_database_fields_invalid");
    expect(() => projectMoodleDatabaseEntrySummary({
      ...databaseEntrySummary, entries_awaiting_approval: 8,
    }, target)).toThrow("moodle_database_entry_summary_invalid");
  });

  it("maps every child read to its own operation and projection", () => {
    expect(moodleActivityContentReadByTool("moodle_get_choice_options")).toMatchObject({
      operation: "moodle.form.choice.options.read.v1", learnerAggregate: false,
    });
    expect(moodleActivityContentReadByTool("moodle_get_feedback_response_summary")).toMatchObject({
      operation: "moodle.form.feedback.response_summary.read.v1", learnerAggregate: true,
    });
    expect(moodleActivityContentReadByTool("moodle_get_database_entry_summary")?.learnerAggregate).toBe(true);
    expect(moodleActivityContentReadByTool("moodle_get_choice")).toBe(null);
  });
});
