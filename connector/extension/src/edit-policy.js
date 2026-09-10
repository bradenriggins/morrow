import { canvasAdmissionReason, canvasOperationAdmission, canvasReadbackAssessment } from "../generated/canvas-operation-admission.js";

export const EDIT_PERMISSION_SCHEMA = "morrow.bridge.edit-permission.v1";
export const EDIT_POLICY_SELECTION_LIMIT = 500;
export const CONVERSATIONAL_EDIT_DURATION_MS = 30 * 60 * 1_000;
export const MAX_EDIT_DURATION_MS = 24 * 60 * 60 * 1_000;
export const SETTINGS_EDIT_DURATIONS = Object.freeze([
  Object.freeze({ value: 30 * 60 * 1_000, label: "30 minutes" }),
  Object.freeze({ value: 60 * 60 * 1_000, label: "1 hour" }),
  Object.freeze({ value: 4 * 60 * 60 * 1_000, label: "4 hours" }),
  Object.freeze({ value: 8 * 60 * 60 * 1_000, label: "8 hours" }),
  Object.freeze({ value: MAX_EDIT_DURATION_MS, label: "24 hours" }),
]);

const STRUCTURAL_EDIT_FIELDS = new Set([
  "course_id", "url_or_id", "id", "topic_id", "module_id", "section_id", "target_section_id", "assignment_id", "item_id", "quiz_id", "expected_digest",
  "chapter_id", "after_chapter_id", "category_id", "grade_item_id", "slot_id", "after_slot_id", "section_number", "section_name", "override_id",
  "page_id", "after_page_id", "expected_jump_changes", "expected_invalid_jumps",
  "bank_id", "bank_entry_id", "quiz_entry_id", "expected_snapshot", "fan_out", "fan_out_receipt", "acknowledged_course_ids", "user_id", "event_id",
  "morrow_page_guard", "morrow_canvas_content_guard", "morrow_item_bank_guard", "morrow_new_quiz_item_position_guard"
]);
const EDIT_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,159}$/;
const EDIT_FIELD_GRANT_LIMIT = 8;
const CANVAS_DESTRUCTIVE_GROUP = "Canvas actions that remove content";
const MOODLE_COURSE_LIFECYCLE_GROUP = "Moodle · Course lifecycle";
const MOODLE_WHOLE_COURSE_TOOLS = new Set(["moodle_hide_course", "moodle_show_course"]);
// A course format change removes nothing, but the new format decides where every section and every
// activity in the course appears, and Morrow cannot put the previous layout back. That wider effect
// is stated before the action is granted, not only at approval.
const MOODLE_COURSE_FORMAT_TOOL = "moodle_change_course_format";
const MOODLE_COURSE_FORMAT_NOTE = "It changes where every section and every activity in the course appears for everyone in it, not one activity, and Morrow cannot put the previous layout back.";
// A backup, a restore, an import and a course copy each act on a whole course, not on one activity
// in it, and each reaches differently: one writes a file, one replaces or adds to everything in the
// course, one copies another course into this one, and one creates a course. They are grouped and
// described together so that reach is stated before the action is granted, not only at approval.
const MOODLE_COURSE_REUSE_GROUP = "Moodle · Course backup and reuse";
const MOODLE_COURSE_REUSE_NOTES = new Map([
  ["moodle_start_course_backup", "It makes a backup file of the whole course. It changes nothing a learner sees, and Morrow cannot delete a backup file."],
  ["moodle_start_course_restore", "It changes the whole course, not one activity in it: a merge adds the backup to what the course already holds, and a delete-and-restore removes everything in the course first. Morrow cannot undo either."],
  ["moodle_start_course_import", "It copies the content of another course into this whole course, not one activity in it, and Morrow cannot undo it."],
  ["moodle_copy_course", "It creates a new course on this Moodle site, hidden and with no learner data, and Morrow cannot delete a course."],
]);
const MOODLE_COURSE_REUSE_TOOLS = new Set([...MOODLE_COURSE_REUSE_NOTES.keys()]);
// A restore can remove everything a course holds before it restores anything, so it is prepared for
// review each time with the exact file, the exact course and the exact mode, never granted ahead.
const MOODLE_COURSE_RESTORE_TOOL = "moodle_start_course_restore";
const MOODLE_COURSE_RESTORE_REVIEW_REASON = "Restoring a backup changes the whole course, and a delete-and-restore removes every section, every activity and every learner record in it first. Morrow cannot undo either. Morrow prepares each restore on its own, with the exact backup file, the exact course and the exact mode, so you approve them one at a time.";
const MOODLE_FORUM_DISCUSSION_GROUP = "Moodle · Forum discussions and posts";
const MOODLE_FORUM_DISCUSSION_TOOLS = new Set([
  "moodle_create_forum_discussion",
  "moodle_reply_to_forum_post",
  "moodle_lock_forum_discussion",
  "moodle_pin_forum_discussion",
  "moodle_set_forum_subscription",
]);
// A saved Forum discussion or reply is visible to every learner who can see the Forum, and Morrow
// has no route that removes it. That is stated before the action is granted, not only at approval.
const MOODLE_LEARNER_POST_TOOLS = new Set(["moodle_create_forum_discussion", "moodle_reply_to_forum_post"]);
const MOODLE_LEARNER_POST_NOTE = "What it posts is visible to every learner who can see the Forum as soon as Moodle saves it, and Morrow cannot remove it.";
// A saved Glossary entry or Wiki page is course content every learner in the activity reads, and
// Morrow has no route that deletes an entry or restores a page. That is stated before the action is
// granted, not only at approval.
const MOODLE_LEARNER_CONTENT_TOOLS = new Set([
  "moodle_create_glossary_entry",
  "moodle_update_glossary_entry",
  "moodle_update_wiki_page",
]);
const MOODLE_LEARNER_CONTENT_NOTE = "It changes what learners read in this activity as soon as Moodle saves it, and Morrow has no route that removes or restores what it saved.";
// A completion condition change is retroactive. Moodle re-evaluates the new conditions against work
// learners have already done, so saving one can mark enrolled learners complete or incomplete
// without anyone opening the activity. That wider effect is stated before the action is granted,
// not only at approval.
const MOODLE_COMPLETION_TOOLS = new Set(["moodle_update_activity_completion", "moodle_update_course_completion"]);
const MOODLE_COMPLETION_NOTE = "It changes what counts as complete for everyone enrolled in the course, and Moodle applies the new conditions to work learners have already done.";
// An access restriction decides who can open the activity or section, and a restriction set to hide
// it entirely takes it out of what those learners see at all. Morrow reads the restriction tree, not
// the roster it selects, so it cannot say who is left in. That is stated before the action is
// granted, not only at approval.
const MOODLE_RESTRICTION_TOOLS = new Set(["moodle_update_activity_restrictions", "moodle_update_section_restrictions"]);
const MOODLE_RESTRICTION_NOTE = "It decides which learners can open this, and a restriction set to hide it entirely takes it out of what they see. Morrow cannot see which learners a restriction lets in.";
// Deleting an activity removes every learner submission, attempt, and grade it holds, and Morrow
// cannot undo it. It is prepared for review each time, with the exact activity and the exact list
// of what goes with it, instead of being granted in advance.
const MOODLE_GROUP_JOINING_WORDS = new Set(["to", "in", "at", "for", "from", "with", "by", "into", "of"]);
const MOODLE_ACTIVITY_DELETE_TOOLS = new Set(["moodle_delete_activity"]);
const MOODLE_ACTIVITY_DELETE_REVIEW_REASON = "Deleting an activity removes its learner submissions, attempts, and grades, and its files, and Morrow cannot undo it. Morrow prepares each deletion on its own, with the exact activity and what the deletion removes with it, so you approve them one at a time.";
// Deleting a section removes every activity in it, so it reaches further than an activity deletion
// and is never a standing grant either.
const MOODLE_SECTION_DELETE_TOOLS = new Set(["moodle_delete_section"]);
const MOODLE_SECTION_DELETE_REVIEW_REASON = "Deleting a section removes every activity in it, with the learner submissions, attempts, grades, and files those activities hold, and Morrow cannot undo it. Morrow prepares each deletion on its own, with the exact section and every activity the deletion removes with it, so you approve them one at a time.";
// Deleting a Lesson page removes the learner attempts at that page, and Moodle leaves every jump
// that pointed at it aimed at a page that no longer exists, so the reach of one deletion depends on
// the rest of the Lesson. It is prepared for review each time, never granted in advance.
const MOODLE_LESSON_PAGE_DELETE_TOOLS = new Set(["moodle_delete_lesson_page"]);
const MOODLE_LESSON_PAGE_DELETE_REVIEW_REASON = "Deleting a Lesson page removes its contents, its answers, and the learner attempts at that page, and Morrow cannot undo it. Moodle leaves every jump that pointed at the page aimed at a page that no longer exists. Morrow prepares each deletion on its own, with the exact page and every page whose jump the deletion breaks, so you approve them one at a time.";
// Deleting a group takes every member out of it, takes it out of every grouping that holds it, and
// removes its calendar events and its group conversation. Which learners that reaches depends on
// who is in the group at the time, so each deletion is prepared for review with that exact list
// instead of being granted in advance.
const MOODLE_GROUP_DELETE_TOOLS = new Set(["moodle_delete_group"]);
const MOODLE_GROUP_DELETE_REVIEW_REASON = "Deleting a group takes every member out of it, takes it out of every grouping that holds it, and removes its calendar events and its group conversation, and Morrow cannot undo it. Morrow prepares each deletion on its own, with the exact group and every member the deletion removes from it, so you approve them one at a time.";
// Group membership and an activity group mode decide which learners see each other's work in a
// separate-groups activity. Both stay Edit-available, and both say that before they are granted.
const MOODLE_GROUP_ACCESS_TOOLS = new Set(["moodle_add_group_member", "moodle_remove_group_member", "moodle_set_activity_group_mode", "moodle_set_grouping_groups"]);
const MOODLE_GROUP_ACCESS_NOTE = "It changes which learners an activity that separates groups shows to each other, as soon as Moodle saves it.";
// A course event and an activity date are two different things, so the calendar actions are grouped
// and described together rather than under the noun in each tool name.
const MOODLE_CALENDAR_GROUP = "Moodle · Calendar";
const MOODLE_CALENDAR_TOOLS = new Set(["moodle_create_course_event", "moodle_update_event"]);
const MOODLE_CALENDAR_NOTE = "A course event is in the calendar of everyone enrolled in the course as soon as Moodle saves it. It is not an activity date: it sets no due, open, or close date on any activity.";
// Deleting a calendar event cannot be undone. It removes no activity and no learner work, and it is
// still prepared for review each time, with the exact event and what the deletion removes with it.
const MOODLE_CALENDAR_DELETE_TOOLS = new Set(["moodle_delete_event"]);
const MOODLE_CALENDAR_DELETE_REVIEW_REASON = "Deleting a calendar event removes it from the calendar of everyone enrolled in the course, with the reminders Moodle still has to send for it, and Morrow cannot undo it. It removes no activity and no learner work. Morrow prepares each deletion on its own, with the exact event and what the deletion removes with it, so you approve them one at a time.";
// Enrolment and role assignment are separate concepts in Moodle, and they stay separate here: each
// write is its own action, and all of them live in one group of their own instead of the per-noun
// groups, because every one of them changes what one person can reach in the course rather than
// course content. Unenrolling is never a standing grant: it can take a learner's grades,
// submissions and participation history with it, and Morrow cannot undo it.
const MOODLE_ENROLMENT_GROUP = "Moodle · Enrolment and roles";
const MOODLE_ENROLMENT_TOOLS = new Set([
  "moodle_enrol_participant",
  "moodle_suspend_participant",
  "moodle_unenrol_participant",
  "moodle_assign_role",
  "moodle_remove_role",
]);
const MOODLE_ENROLMENT_NOTES = new Map([
  ["moodle_enrol_participant", "It puts one exact person into this course, with the role this course's manual enrolment method gives, and Morrow removes nobody as part of it."],
  ["moodle_suspend_participant", "It takes one exact person's access to this course away until someone makes the enrolment active again. They keep their grades and their work, and Morrow has no route that reverses it: a person does that on the Participants page in Moodle."],
  ["moodle_assign_role", "It changes what one exact person can do in this course. It changes no enrolment, so it puts nobody into the course and takes nobody out of it."],
  ["moodle_remove_role", "It changes what one exact person can do in this course. It changes no enrolment, so it takes nobody out of the course, and Moodle keeps a role that an enrolment method granted and protects."],
  ["moodle_unenrol_participant", "It removes one exact person from this course, and it can take their grades, their submissions and their participation history with them. Morrow cannot undo it."],
]);
const MOODLE_UNENROL_TOOLS = new Set(["moodle_unenrol_participant"]);
const MOODLE_UNENROL_REVIEW_REASON = "Unenrolling one person from a course can remove their grades, their submissions and their participation history in it, and Morrow cannot undo it. Morrow prepares each unenrolment on its own, with the exact person and everything the removal takes with them, so you approve them one at a time.";
const COURSE_SCOPE_REVIEW_REASON = "Morrow cannot prove from this operation that the change targets only the selected course.";
const CURATED_ROUTE_MISSING_REASON = "This repair needs Canvas routes the connected catalog does not carry, so Morrow cannot read the exact saved result back.";
// New Quizzes matches the parts of a question by the ids the question already
// holds, so an in-place change that renumbers them can leave the old parts
// behind as blank answers. Section 2.2 of
// docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md records
// the harvested production evidence. That risk lives in
// new-quiz-item-guard.js's newQuizIdsPreserved, enforced on the write itself
// in canvas-content.js, not here: the general update is not a destructive
// route (it removes nothing Canvas
// cannot restore by another update), so it is a standing Edit grant like any
// other update, the same as the two curated New Quiz repairs above.
// Deleting a New Quiz is destructive and irreversible: Canvas does not
// restore it, and the deletion takes every item in it too. Morrow's guided
// New Quiz delete tool proves the quiz carries no submitted or graded
// student work first; this raw route is the only way to reach a delete
// without that proof, so it stays review-only. Creating a New Quiz removes
// nothing and Canvas assigns a fresh id, so it is a standing Edit grant.
const NEW_QUIZ_DELETE_REVIEW_REASON = "Deleting a New Quiz removes it and every item in it, and Canvas does not restore it. Morrow prepares each deletion on its own, after confirming the quiz carries no submitted or graded student work, so you approve them one at a time.";
const NEW_QUIZ_DELETE_TOOL = "canvas_delete_new_quiz";
// Archiving an Item Bank and deleting a bank entry or a quiz's use of one are
// destructive and irreversible, and each can reach every quiz, in every
// course, that draws from the bank - Canvas exposes no account-wide list of
// those quizzes, so Morrow cannot show how far the change reaches. Every one
// of the three carries the observed courses Morrow did find and the
// person's acknowledgement of exactly those courses, evidence for one
// change at one moment, so none of the three is a standing grant. Creating,
// attaching, sharing, renaming, and updating an item remove nothing and stay
// standing Edit grants.
const ITEM_BANK_DESTRUCTIVE_REASON = "This Item Bank change cannot be undone, and it can reach every quiz, in every course, that draws from the bank - Canvas provides no complete list of everything that uses one. Morrow shows you the courses it did find and asks you to confirm them for each change, so this one is approved change by change rather than switched on in advance.";
const ITEM_BANK_DESTRUCTIVE_TOOLS = new Set(["canvas_item_bank_archive_bank", "canvas_item_bank_delete_entry", "canvas_item_bank_delete_quiz_bank_entry"]);
const VERIFICATION_CLAUSES = Object.freeze({
  student_grade_or_submission_state: "reading it back would open a student grade or submission",
  discussion_or_conversation_content: "reading it back would open student discussion or message content",
  favorite_list_is_effective_not_explicit_state: "Canvas reports an effective favorites list, not the saved setting",
  summary_state_has_no_narrow_reader: "Canvas has no narrow read for this summary setting",
  external_tool_update_has_no_cataloged_fields: "this external tool update has no cataloged fields to compare",
  content_migration_update_has_no_cataloged_fields: "this content migration update has no cataloged fields to compare",
  module_item_reader_mutates_progress: "the only Canvas read for it would change module progress",
  module_progression_state_has_no_current_user_reader: "Canvas has no read of module progression for this person",
  no_safe_readback_route: "Canvas has no read that shows this exact change",
  no_exact_postcondition: "Canvas has no read that proves the exact saved result",
});
const DEFAULT_VERIFICATION_CLAUSE = "Morrow has no read that proves the exact saved result";
const CHECKED = Object.freeze({ verification: "checked" });

const CURATED_CATEGORY_SPECS = Object.freeze([
  Object.freeze({
    id: "dates",
    group: "Common Moodle actions",
    label: "Change Moodle assignment and quiz dates",
    description: "Change Moodle Assignment due dates and Quiz open or close dates in this course.",
    provider: "moodle",
    rules: Object.freeze([
      Object.freeze({ provider: "moodle", operationKey: "moodle.form.course.modedit.assign.write.v1", toolName: "moodle_update_assignment", allowedChangedFields: Object.freeze(["due_date"]) }),
      Object.freeze({ provider: "moodle", operationKey: "moodle.form.course.modedit.quiz.write.v1", toolName: "moodle_update_quiz", allowedChangedFields: Object.freeze(["close_at", "open_at"]) }),
    ]),
  }),
  Object.freeze({
    id: "content",
    group: "Common Moodle actions",
    label: "Edit Moodle lesson content",
    description: "Edit saved Moodle Page, Text and media area, Assignment, and Quiz titles or content in this course.",
    provider: "moodle",
    rules: Object.freeze([
      Object.freeze({ provider: "moodle", operationKey: "moodle.form.course.modedit.page.write.v1", toolName: "moodle_update_page", allowedChangedFields: Object.freeze(["content", "name"]) }),
      Object.freeze({ provider: "moodle", operationKey: "moodle.form.course.modedit.label.write.v1", toolName: "moodle_update_label", allowedChangedFields: Object.freeze(["content"]) }),
      Object.freeze({ provider: "moodle", operationKey: "moodle.form.course.modedit.assign.write.v1", toolName: "moodle_update_assignment", allowedChangedFields: Object.freeze(["instructions", "name"]) }),
      Object.freeze({ provider: "moodle", operationKey: "moodle.form.course.modedit.quiz.write.v1", toolName: "moodle_update_quiz", allowedChangedFields: Object.freeze(["instructions", "name"]) }),
    ]),
  }),
  Object.freeze({
    id: "organize",
    group: "Common Moodle actions",
    label: "Organize Moodle course structure",
    description: "Move an existing Moodle activity or show or hide an existing Moodle section or activity.",
    provider: "moodle",
    rules: Object.freeze([
      Object.freeze({ provider: "moodle", operationKey: "moodle.ajax.core_courseformat_update_course.cm_move.v1", toolName: "moodle_move_activity", allowedChangedFields: Object.freeze([]) }),
      Object.freeze({ provider: "moodle", operationKey: "moodle.ajax.core_courseformat_update_course.section_show.v1", toolName: "moodle_show_section", allowedChangedFields: Object.freeze([]) }),
      Object.freeze({ provider: "moodle", operationKey: "moodle.ajax.core_courseformat_update_course.section_hide.v1", toolName: "moodle_hide_section", allowedChangedFields: Object.freeze([]) }),
      Object.freeze({ provider: "moodle", operationKey: "moodle.ajax.core_courseformat_update_course.cm_show.v1", toolName: "moodle_show_activity", allowedChangedFields: Object.freeze([]) }),
      Object.freeze({ provider: "moodle", operationKey: "moodle.ajax.core_courseformat_update_course.cm_hide.v1", toolName: "moodle_hide_activity", allowedChangedFields: Object.freeze([]) }),
    ]),
  }),
  Object.freeze({
    id: "canvas_page_content",
    group: "Focused Canvas repairs",
    label: "Correct Canvas Page text",
    description: "Correct one unique visible text selection in a Canvas Page. It does not change the Page title or other page content.",
    provider: "canvas",
    rules: Object.freeze([
      Object.freeze({ provider: "canvas", operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses", toolName: "canvas_update_create_page_courses", allowedChangedFields: Object.freeze([]), requiresCanvasContentGuard: true, canvasContentGuardKind: "page_text" }),
    ]),
  }),
  Object.freeze({
    id: "canvas_page_image_alt",
    group: "Focused Canvas repairs",
    label: "Add Canvas Page image alternative text",
    description: "Add alternative text to one selected image without alternative text in a Canvas Page. It does not change the Page title or other page content.",
    provider: "canvas",
    rules: Object.freeze([
      Object.freeze({ provider: "canvas", operationKey: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses", toolName: "canvas_update_create_page_courses", allowedChangedFields: Object.freeze([]), requiresCanvasContentGuard: true, canvasContentGuardKind: "page_image_alt" }),
    ]),
  }),
  Object.freeze({
    id: "canvas_assignment_image_alt",
    group: "Focused Canvas repairs",
    label: "Add Canvas Assignment image alternative text",
    description: "Add alternative text to one selected image without alternative text in a Canvas Assignment description. It does not change the Assignment name, dates, points, publication, or other settings.",
    provider: "canvas",
    rules: Object.freeze([
      Object.freeze({ provider: "canvas", operationKey: "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment", toolName: "canvas_edit_assignment", allowedChangedFields: Object.freeze([]), requiresCanvasContentGuard: true, canvasContentGuardKind: "assignment_image_alt" }),
    ]),
  }),
  Object.freeze({
    id: "canvas_discussion_image_alt",
    group: "Focused Canvas repairs",
    label: "Add Canvas Discussion image alternative text",
    description: "Add alternative text to one selected image without alternative text in a Canvas Discussion message. It does not change the Discussion title, availability, or other settings.",
    provider: "canvas",
    rules: Object.freeze([
      Object.freeze({ provider: "canvas", operationKey: "PUT /v1/courses/{course_id}/discussion_topics/{topic_id}#update_topic_courses", toolName: "canvas_update_topic_courses", allowedChangedFields: Object.freeze([]), requiresCanvasContentGuard: true, canvasContentGuardKind: "discussion_image_alt" }),
    ]),
  }),
  Object.freeze({
    id: "canvas_classic_quiz_description_image_alt",
    group: "Focused Canvas repairs",
    label: "Add Canvas Classic Quiz description image alternative text",
    description: "Add alternative text to one selected image without alternative text in a Canvas Classic Quiz description. It does not change questions, answers, points, availability, publication, or other settings.",
    provider: "canvas",
    rules: Object.freeze([
      Object.freeze({ provider: "canvas", operationKey: "PUT /v1/courses/{course_id}/quizzes/{id}#edit_quiz", toolName: "canvas_edit_quiz", allowedChangedFields: Object.freeze([]), requiresCanvasContentGuard: true, canvasContentGuardKind: "classic_quiz_description_image_alt" }),
    ]),
  }),
  Object.freeze({
    id: "canvas_classic_quiz_question_image_alt",
    group: "Focused Canvas repairs",
    label: "Add Canvas Classic Quiz question image alternative text",
    description: "Add alternative text to one selected image without alternative text in one Canvas Classic Quiz question or one of its answers. It does not change the question wording, answers, correct answer, points, feedback, or position. Morrow refuses a question that comes from a question group or bank, and a question type it cannot rebuild in full.",
    provider: "canvas",
    // Canvas rebuilds a Classic Quiz question from the whole request through
    // AssessmentQuestion.parse_question, so the connector reads the question
    // again and resends every field it returned. Only a connected tenant can
    // prove that no hidden question state is lost, so this repair is
    // live-unverified. connector/extension/src/canvas-content.js refuses any
    // question whose fresh read is incomplete or carries state this write
    // cannot resend.
    requiresOperations: Object.freeze(["canvas_update_existing_quiz_question", "canvas_get_single_quiz_question"]),
    rules: Object.freeze([
      Object.freeze({ provider: "canvas", operationKey: "PUT /v1/courses/{course_id}/quizzes/{quiz_id}/questions/{id}#update_existing_quiz_question", toolName: "canvas_update_existing_quiz_question", allowedChangedFields: Object.freeze([]), requiresCanvasContentGuard: true, canvasContentGuardKind: "classic_quiz_question_image_alt" }),
    ]),
  }),
  Object.freeze({
    id: "canvas_new_quiz_item_image_alt",
    group: "Focused Canvas repairs",
    label: "Add Canvas New Quiz item image alternative text",
    description: "Add alternative text to one selected image without alternative text in one Canvas New Quiz item. It does not change the item question, answers, points, or settings.",
    provider: "canvas",
    rules: Object.freeze([
      Object.freeze({ provider: "canvas", operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item", toolName: "canvas_update_quiz_item", allowedChangedFields: Object.freeze([]), requiresCanvasContentGuard: true, canvasContentGuardKind: "new_quiz_item_image_alt" }),
    ]),
  }),
  Object.freeze({
    id: "canvas_new_quiz_nested_image_alt",
    group: "Focused Canvas repairs",
    label: "Add Canvas New Quiz choice and feedback image alternative text",
    description: "Add alternative text to one selected image in a Canvas New Quiz answer choice or feedback field. It does not change the item question, answer choice, feedback text, points, or settings.",
    provider: "canvas",
    rules: Object.freeze([
      Object.freeze({ provider: "canvas", operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item", toolName: "canvas_update_quiz_item", allowedChangedFields: Object.freeze([]), requiresCanvasContentGuard: true, canvasContentGuardKind: "new_quiz_choice_image_alt" }),
      Object.freeze({ provider: "canvas", operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item", toolName: "canvas_update_quiz_item", allowedChangedFields: Object.freeze([]), requiresCanvasContentGuard: true, canvasContentGuardKind: "new_quiz_answer_feedback_image_alt" }),
      Object.freeze({ provider: "canvas", operationKey: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item", toolName: "canvas_update_quiz_item", allowedChangedFields: Object.freeze([]), requiresCanvasContentGuard: true, canvasContentGuardKind: "new_quiz_feedback_image_alt" }),
    ]),
  }),
  Object.freeze({
    id: "canvas_inbox_messages",
    group: "Focused Canvas repairs",
    label: "Send Canvas Inbox messages in this course",
    description: "Send one reviewed Canvas Inbox conversation or reply in this course. Morrow refreshes the course connection and recipient scope before it sends the message.",
    provider: "canvas",
    rules: Object.freeze([
      Object.freeze({ provider: "canvas", operationKey: "canvas.private.conversation.send.v1", toolName: "canvas_send_private_conversation", allowedChangedFields: Object.freeze([]) }),
    ]),
  }),
  Object.freeze({
    id: "canvas_assignment_due_date",
    group: "Focused Canvas repairs",
    label: "Change Canvas Assignment due date only",
    description: "Change the due date for an existing Canvas Assignment. It does not change availability, instructions, points, publication, or other settings.",
    provider: "canvas",
    rules: Object.freeze([
      Object.freeze({ provider: "canvas", operationKey: "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment", toolName: "canvas_edit_assignment", allowedChangedFields: Object.freeze(["assignment_due_at"]) }),
    ]),
  }),
]);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function operationProvider(operation) {
  return operation?.provider === "moodle" ? "moodle" : operation?.provider === "canvas" ? "canvas" : null;
}

function operationProperties(operation) {
  const properties = operation?.inputSchema?.properties;
  return properties && typeof properties === "object" && !Array.isArray(properties) ? properties : {};
}

function changedFieldsForOperation(operation) {
  return Object.keys(operationProperties(operation))
    .filter((field) => EDIT_FIELD.test(field) && !STRUCTURAL_EDIT_FIELDS.has(field))
    .sort();
}

function moodleCourseScoped(operation) {
  return Object.hasOwn(operationProperties(operation), "course_id");
}

function canvasWriteAdmission(operation) {
  if (typeof operation?.path !== "string") return { state: "held" };
  return canvasOperationAdmission(operation).write;
}

function canvasReadOperations(operations) {
  return (Array.isArray(operations) ? operations : []).filter((entry) => operationProvider(entry) === "canvas" && typeof entry.path === "string");
}

function unchecked(reason) {
  return {
    verification: "unchecked",
    verificationReason: `Morrow cannot check this change after it is saved: ${VERIFICATION_CLAUSES[reason] || DEFAULT_VERIFICATION_CLAUSE}. Morrow reports the saved result as unconfirmed.`,
  };
}

// Morrow checks a saved change through the route that applies it. Guarded Canvas content, Page
// writes, the private Inbox route and every browser-catalog route read their own saved state back,
// so only the generic Canvas API route depends on the shared readback assessment. The admitted
// Item Bank quiz draw uses its frame-owned operation-specific readback.
function operationVerification(operation, canvasReads, rule) {
  if (!operation) return unchecked();
  if (operationProvider(operation) !== "canvas") return CHECKED;
  if (rule?.requiresCanvasContentGuard || rule?.requiresPageGuard || rule?.requiresItemBankGuard || operation.morrowPrivate === true) return CHECKED;
  const assessment = canvasReadbackAssessment(canvasReads, operation);
  return assessment.state === "structurally_exact" ? CHECKED : unchecked(assessment.reason);
}

function operationAvailability(operation) {
  const provider = operationProvider(operation);
  if (!provider || operation?.readOnly !== false) return { availability: "review", reviewReason: "This catalog entry is not a course Edit action." };
  if (provider === "canvas") {
    if (NEW_QUIZ_DELETE_TOOL === operation.toolName) return { availability: "review", reviewReason: NEW_QUIZ_DELETE_REVIEW_REASON };
    if (ITEM_BANK_DESTRUCTIVE_TOOLS.has(operation.toolName || "")) return { availability: "review", reviewReason: ITEM_BANK_DESTRUCTIVE_REASON };
    const admission = canvasWriteAdmission(operation);
    return admission.state === "admitted"
      ? { availability: "edit" }
      : { availability: "review", reviewReason: canvasAdmissionReason(admission) || COURSE_SCOPE_REVIEW_REASON };
  }
  if (MOODLE_ACTIVITY_DELETE_TOOLS.has(operation.toolName || "")) {
    return { availability: "review", reviewReason: MOODLE_ACTIVITY_DELETE_REVIEW_REASON };
  }
  if (MOODLE_SECTION_DELETE_TOOLS.has(operation.toolName || "")) {
    return { availability: "review", reviewReason: MOODLE_SECTION_DELETE_REVIEW_REASON };
  }
  if (MOODLE_LESSON_PAGE_DELETE_TOOLS.has(operation.toolName || "")) {
    return { availability: "review", reviewReason: MOODLE_LESSON_PAGE_DELETE_REVIEW_REASON };
  }
  if (MOODLE_GROUP_DELETE_TOOLS.has(operation.toolName || "")) {
    return { availability: "review", reviewReason: MOODLE_GROUP_DELETE_REVIEW_REASON };
  }
  if (MOODLE_CALENDAR_DELETE_TOOLS.has(operation.toolName || "")) {
    return { availability: "review", reviewReason: MOODLE_CALENDAR_DELETE_REVIEW_REASON };
  }
  if (MOODLE_UNENROL_TOOLS.has(operation.toolName || "")) {
    return { availability: "review", reviewReason: MOODLE_UNENROL_REVIEW_REASON };
  }
  if (String(operation.toolName || "") === MOODLE_COURSE_RESTORE_TOOL) {
    return { availability: "review", reviewReason: MOODLE_COURSE_RESTORE_REVIEW_REASON };
  }
  return moodleCourseScoped(operation)
    ? { availability: "edit" }
    : { availability: "review", reviewReason: COURSE_SCOPE_REVIEW_REASON };
}

// A Canvas API entry carries a risk annotation, a browser-catalog entry carries a destructive
// annotation, and any DELETE route removes what it names.
function destructiveOperation(operation) {
  return operation?.risk === "destructive" || operation?.destructive === true
    || String(operation?.method || "").toUpperCase() === "DELETE";
}

// A description longer than the card holds ends at a whole word, so the reader
// can see that the sentence continues instead of reading a cut word.
function shortened(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, Math.max(0, limit - 1));
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

function fieldSelectionNote(count) {
  return `This action can change ${count} different settings. Morrow does not grant all of them at once, so selecting it alone does not let Morrow change any of them. Morrow can still prepare this change for your review.`;
}

// A Moodle write that removes or replaces content, or that changes whether the whole course is
// visible, reaches past the one activity it names. It stays Edit-available, and it is grouped and
// described apart from the per-noun actions so the wider effect is stated before it is granted.
function moodleCourseLifecycle(operation) {
  // An enrolment or role change reaches one person, not the course's content, so it is described
  // and grouped as itself instead of as a course-lifecycle change.
  return operationProvider(operation) === "moodle"
    && !MOODLE_ENROLMENT_TOOLS.has(String(operation?.toolName || ""))
    && !MOODLE_COURSE_REUSE_TOOLS.has(String(operation?.toolName || ""))
    && (destructiveOperation(operation) || MOODLE_WHOLE_COURSE_TOOLS.has(String(operation?.toolName || ""))
      || String(operation?.toolName || "") === MOODLE_COURSE_FORMAT_TOOL);
}

function moodleLifecycleNote(operation) {
  if (String(operation?.toolName || "") === MOODLE_COURSE_FORMAT_TOOL) return MOODLE_COURSE_FORMAT_NOTE;
  if (MOODLE_WHOLE_COURSE_TOOLS.has(String(operation?.toolName || ""))) {
    return "It changes whether the whole course is visible to every enrolled learner, not one activity in it.";
  }
  return operation?.irreversible === true
    ? "It removes or replaces saved course content for everyone in the course, and Morrow cannot undo it."
    : "It removes or replaces saved course content for everyone in the course.";
}

function moodleGroup(operation) {
  const toolName = String(operation?.toolName || "").replace(/^moodle_(?:create|update|delete|show|hide|move|duplicate|replace|set|add|remove)_/, "");
  const words = [];
  // The group is named after the thing the action acts on, so the name stops
  // where the tool name starts describing the action instead.
  for (const part of toolName.split("_").filter(Boolean)) {
    if (words.length === 2 || MOODLE_GROUP_JOINING_WORDS.has(part)) break;
    words.push(part);
  }
  const noun = words.map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
  return noun ? `Moodle · ${noun}` : "Moodle course actions";
}

function operationGroup(operation) {
  if (operationProvider(operation) === "moodle") {
    if (MOODLE_ENROLMENT_TOOLS.has(String(operation?.toolName || ""))) return MOODLE_ENROLMENT_GROUP;
    if (MOODLE_COURSE_REUSE_TOOLS.has(String(operation?.toolName || ""))) return MOODLE_COURSE_REUSE_GROUP;
    if (moodleCourseLifecycle(operation)) return MOODLE_COURSE_LIFECYCLE_GROUP;
    if (MOODLE_FORUM_DISCUSSION_TOOLS.has(String(operation?.toolName || ""))) return MOODLE_FORUM_DISCUSSION_GROUP;
    if (MOODLE_CALENDAR_TOOLS.has(String(operation?.toolName || ""))) return MOODLE_CALENDAR_GROUP;
    return moodleGroup(operation);
  }
  if (destructiveOperation(operation)) return CANVAS_DESTRUCTIVE_GROUP;
  return `Canvas · ${String(operation?.resource || "Course actions")}`;
}

function operationSpec(operation, canvasReads) {
  const provider = operationProvider(operation);
  const availability = operationAvailability(operation);
  const fields = changedFieldsForOperation(operation);
  const requiresFieldSelection = availability.availability === "edit" && fields.length > EDIT_FIELD_GRANT_LIMIT;
  const note = [
    moodleCourseLifecycle(operation) ? moodleLifecycleNote(operation) : "",
    MOODLE_COURSE_REUSE_NOTES.get(String(operation?.toolName || "")) || "",
    MOODLE_LEARNER_POST_TOOLS.has(String(operation?.toolName || "")) ? MOODLE_LEARNER_POST_NOTE : "",
    MOODLE_LEARNER_CONTENT_TOOLS.has(String(operation?.toolName || "")) ? MOODLE_LEARNER_CONTENT_NOTE : "",
    MOODLE_COMPLETION_TOOLS.has(String(operation?.toolName || "")) ? MOODLE_COMPLETION_NOTE : "",
    MOODLE_GROUP_ACCESS_TOOLS.has(String(operation?.toolName || "")) ? MOODLE_GROUP_ACCESS_NOTE : "",
    MOODLE_ENROLMENT_NOTES.get(String(operation?.toolName || "")) || "",
    MOODLE_RESTRICTION_TOOLS.has(String(operation?.toolName || "")) ? MOODLE_RESTRICTION_NOTE : "",
    MOODLE_CALENDAR_TOOLS.has(String(operation?.toolName || "")) ? MOODLE_CALENDAR_NOTE : "",
    requiresFieldSelection ? fieldSelectionNote(fields.length) : "",
  ].filter(Boolean).join(" ");
  const label = (String(operation?.summary || operation?.toolName || "Catalog course action").trim() || "Catalog course action").slice(0, 300);
  const description = shortened(String(operation?.description || "No catalog description is available.").trim() || "No catalog description is available.", 1_000 - (note ? note.length + 1 : 0));
  return {
    id: `action:${provider}:${operation.toolName}`,
    group: operationGroup(operation),
    label,
    description: note ? `${description} ${note}` : description,
    provider,
    destructive: destructiveOperation(operation),
    ...(requiresFieldSelection ? { requiresFieldSelection: true } : {}),
    ...availability,
    ...(availability.availability === "edit" ? operationVerification(operation, canvasReads) : {}),
    rules: availability.availability === "edit" ? [{
      provider,
      operationKey: operation.key,
      toolName: operation.toolName,
      allowedChangedFields: requiresFieldSelection ? [] : fields,
    }] : [],
  };
}

// A curated repair can name the reads it needs as well as the write it sends. When the connected
// catalog is missing one of them the repair cannot run, so it is published for review instead of
// being offered and then refused at the moment a person tries to save it.
function curatedAvailability(spec, operations) {
  const present = (toolName) => (Array.isArray(operations) ? operations : []).some((entry) => entry?.toolName === toolName);
  return (spec.requiresOperations || []).every(present) ? { availability: "edit" } : { availability: "review", reviewReason: CURATED_ROUTE_MISSING_REASON };
}

function categorySpecsForBinding(binding, operations) {
  const provider = binding?.provider;
  if (provider !== "canvas" && provider !== "moodle") return [];
  const canvasReads = canvasReadOperations(operations);
  const curated = CURATED_CATEGORY_SPECS.filter((spec) => spec.provider === provider).map((spec) => {
    const availability = curatedAvailability(spec, operations);
    return {
      ...spec,
      ...availability,
      destructive: ruleSetDestructive(spec.rules, operations),
      ...(availability.availability === "edit" ? ruleSetVerification(spec.rules, operations, canvasReads) : {}),
    };
  });
  const catalogActions = (Array.isArray(operations) ? operations : [])
    .filter((operation) => operationProvider(operation) === provider && operation?.readOnly === false && operation?.morrowPrivate !== true)
    .map((operation) => operationSpec(operation, canvasReads));
  const byId = new Map();
  for (const spec of [...curated, ...catalogActions]) {
    if (!byId.has(spec.id)) byId.set(spec.id, spec);
  }
  return [...byId.values()].sort((left, right) => left.group.localeCompare(right.group) || left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

function publicCategory(spec) {
  return {
    id: spec.id,
    group: spec.group,
    label: spec.label,
    description: spec.description,
    availability: spec.availability,
    tier: spec.destructive === true ? "destructive" : "standard",
    destructive: spec.destructive === true,
    ...(spec.requiresFieldSelection ? { requiresFieldSelection: true } : {}),
    ...(spec.reviewReason ? { reviewReason: spec.reviewReason } : {}),
    ...(spec.verification ? { verification: spec.verification } : {}),
    ...(spec.verificationReason ? { verificationReason: spec.verificationReason } : {}),
  };
}

export function categoriesForBinding(binding, operations) {
  return categorySpecsForBinding(binding, operations).map(publicCategory);
}

function selectedCategories(enabledCategories, binding, operations) {
  if (!Array.isArray(enabledCategories) || enabledCategories.some((entry) => typeof entry !== "string")) throw new Error("edit_policy_categories_invalid");
  const selected = [...new Set(enabledCategories)].sort();
  if (!selected.length || selected.length !== enabledCategories.length || selected.length > EDIT_POLICY_SELECTION_LIMIT) throw new Error("edit_policy_categories_invalid");
  const available = new Map(categorySpecsForBinding(binding, operations).map((spec) => [spec.id, spec]));
  const specs = selected.map((id) => available.get(id));
  if (specs.some((entry) => !entry || entry.availability !== "edit")) throw new Error("edit_policy_category_unavailable");
  return { selected, specs };
}

function ruleOperation(operations, rule) {
  return (Array.isArray(operations) ? operations : []).find((entry) => entry.key === rule.operationKey && entry.toolName === rule.toolName);
}

function ruleSetDestructive(rules, operations) {
  return rules.some((rule) => destructiveOperation(ruleOperation(operations, rule)));
}

function ruleSetVerification(rules, operations, canvasReads) {
  return rules.map((rule) => operationVerification(ruleOperation(operations, rule), canvasReads, rule))
    .find((entry) => entry.verification === "unchecked") || CHECKED;
}

function exactRule(rule, operations) {
  const operation = ruleOperation(operations, rule);
  if (!operation || operationProvider(operation) !== rule.provider || operation.readOnly !== false) throw new Error("edit_policy_catalog_rule_missing");
  const actualFields = new Set(changedFieldsForOperation(operation));
  if (rule.allowedChangedFields.some((field) => !actualFields.has(field))) throw new Error("edit_policy_catalog_rule_missing");
  return {
    operationKey: rule.operationKey,
    toolName: rule.toolName,
    allowedChangedFields: [...new Set(rule.allowedChangedFields)].sort(),
    ...(rule.requiresPageGuard ? { requiresPageGuard: true } : {}),
    ...(rule.pageGuardKind ? { pageGuardKind: rule.pageGuardKind } : {}),
    ...(rule.requiresCanvasContentGuard ? { requiresCanvasContentGuard: true } : {}),
    ...(rule.canvasContentGuardKind ? { canvasContentGuardKind: rule.canvasContentGuardKind } : {}),
    ...(rule.requiresItemBankGuard ? { requiresItemBankGuard: true } : {}),
    ...(rule.itemBankGuardKind ? { itemBankGuardKind: rule.itemBankGuardKind } : {}),
  };
}

function ruleIdentity(rule) {
  return `${rule.operationKey}\u0000${rule.toolName}\u0000${rule.pageGuardKind || ""}\u0000${rule.canvasContentGuardKind || ""}\u0000${rule.itemBankGuardKind || ""}`;
}

function mergeRules(rules) {
  const merged = new Map();
  for (const rule of rules) {
    const key = ruleIdentity(rule);
    const prior = merged.get(key);
    if (!prior) {
      merged.set(key, { ...rule, allowedChangedFields: [...rule.allowedChangedFields] });
      continue;
    }
    prior.allowedChangedFields = [...new Set([...prior.allowedChangedFields, ...rule.allowedChangedFields])].sort();
  }
  return [...merged.values()].sort((left, right) => ruleIdentity(left).localeCompare(ruleIdentity(right)));
}

function scope(binding, catalogDigest, revision, enabledCategories, rules, expiresAt) {
  return {
    schema: EDIT_PERMISSION_SCHEMA,
    sourceBindingId: binding.sourceBindingId,
    provider: binding.provider,
    origin: binding.origin,
    siteUrl: binding.siteUrl || "",
    principalFingerprint: binding.principalFingerprint,
    courseId: binding.courseId || "",
    sessionGeneration: binding.sessionGeneration,
    catalogDigest,
    revision,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    enabledCategories,
    rules,
  };
}

export function validEditDuration(value) {
  return Number.isSafeInteger(value) && SETTINGS_EDIT_DURATIONS.some((entry) => entry.value === value);
}

export async function createEditPermission({ binding, catalogDigest, revision, enabledCategories, operations, expiresAt }) {
  if (!binding?.sourceBindingId || !binding.provider || !binding.origin || !binding.principalFingerprint || !Number.isSafeInteger(binding.sessionGeneration) || binding.sessionGeneration < 1) {
    throw new Error("edit_policy_binding_invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(catalogDigest || "") || !Number.isSafeInteger(revision) || revision < 1) throw new Error("edit_policy_scope_invalid");
  if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + MAX_EDIT_DURATION_MS)) throw new Error("edit_policy_expiration_invalid");
  const { selected, specs } = selectedCategories(enabledCategories, binding, operations);
  const rules = mergeRules(specs.flatMap((spec) => spec.rules.map((rule) => exactRule(rule, operations))));
  const scopeDigest = await digest(scope(binding, catalogDigest, revision, selected, rules, expiresAt));
  return { schema: EDIT_PERMISSION_SCHEMA, revision, scopeDigest, catalogDigest, sourceBindingId: binding.sourceBindingId, ...(expiresAt === undefined ? {} : { expiresAt }), enabledCategories: selected, rules };
}

export async function validEditPermission({ permission, binding, catalogDigest, operations }) {
  if (!permission || permission.schema !== EDIT_PERMISSION_SCHEMA || permission.sourceBindingId !== binding.sourceBindingId
    || (permission.expiresAt !== undefined && (!Number.isSafeInteger(permission.expiresAt) || permission.expiresAt <= Date.now()))) return null;
  try {
    const expected = await createEditPermission({ binding, catalogDigest, revision: permission.revision, enabledCategories: permission.enabledCategories, operations, expiresAt: permission.expiresAt });
    return stable(expected) === stable(permission) ? expected : null;
  } catch {
    return null;
  }
}

export function changedFields(args) {
  return Object.keys(args || {}).filter((key) => !STRUCTURAL_EDIT_FIELDS.has(key)).sort();
}

// Legacy callers used a separate guarded repair rule. Current Item Bank writes
// use the ordinary exact operation rule plus an operation-scoped observed reach
// acknowledgement in their required arguments.
export function guardedItemBankUpdate() {
  return null;
}
