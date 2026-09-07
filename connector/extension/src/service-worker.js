import { shouldOpenSetupOnInstall } from "../onboarding/onboarding-install.js";
import { executeItemBankInPage } from "./item-bank-executor.js";
import { ITEM_BANK_FRAME_HOST_PATTERN, itemBankFrameIds } from "./item-bank-frames.js";
import { canClaimCourseConnectionIntent, canCompleteCourseConnectionIntent, normalizeCourseConnectionUrl, validCourseConnectionIntent } from "./course-connection-intent.js";
import { MAX_FILE_TEXT_BYTES, canvasFileTextContentTypeSupported, executeCanvasCourseFileTextInPage } from "./canvas-file-content.js";
import { CANVAS_FILE_SIGNALS_OPERATION_KEY, CANVAS_FILE_SIGNALS_SCHEMA, CANVAS_FILE_SIGNALS_TOOL_NAME, canvasCourseFileSignals, canvasFileSignalsContentTypeSupported } from "./canvas-file-signals.js";
import { executeCanvasCourseFileTransferInPage } from "./canvas-file-transfer.js";
import { PRIVATE_CANVAS_CONVERSATION_OPERATION, PRIVATE_CANVAS_CONVERSATION_TOOL, canvasConversationOperationMatches, executeCanvasConversationInPage, normalizeCanvasConversationPrivatePayload } from "./canvas-conversations.js";
import { bridgeWriteFailureCode } from "./canvas-write-outcome.js";
import { canvasOperationAdmission } from "../generated/canvas-operation-admission.js";
import { CANVAS_MULTI_CONTEXT_REFUSAL, canvasSemanticContextInputState, canvasSemanticCourseCollectionArguments, canvasSemanticCourseCollectionState, canvasSemanticObjectContext, canvasSemanticObjectVersion, canvasSemanticResolutionProblem, canvasSemanticResolvedCourseId, canvasSemanticSeriesInput, canvasSemanticVersionState } from "../generated/canvas-semantic-target.js";
import { evaluateBrowserReadback, planBrowserReadback, planCanvasRecoveryDescriptor } from "./verification.js";
import { evaluateCanvasOperationProgress, evaluateCanvasOperationReadback, isCanvasOperationReadback, planCanvasOperationReadback } from "./canvas-operation-readback.js";
import { executeMoodleInPage } from "./moodle-executor.js";
import { executeMoodleForumActivitySummaryInPage } from "./moodle-forum-activity-summary-read.js";
import { executeMoodleForumPostInPage } from "./moodle-forum-post-executor.js";
import { executeMoodleForumReadInPage } from "./moodle-forum-read.js";
import { executeMoodleGlossaryWikiInPage } from "./moodle-glossary-wiki-executor.js";
import { executeMoodleCourseGroupsInPage } from "./moodle-groups-read.js";
import { executeMoodleGroupsLifecycleInPage } from "./moodle-groups-executor.js";
import { executeMoodleCourseParticipantsInPage, executeMoodleEnrolmentMethodsInPage, executeMoodleParticipantEnrolmentInPage } from "./moodle-participants-read.js";
import { executeMoodleEnrolmentInPage } from "./moodle-enrolment-executor.js";
import { executeMoodleCourseSettingsInPage } from "./moodle-course-settings-executor.js";
import { executeMoodleCalendarInPage } from "./moodle-calendar-executor.js";
import { executeMoodleCompletionInPage } from "./moodle-completion-executor.js";
import { executeMoodleRestrictionsInPage } from "./moodle-restrictions-executor.js";
import { executeMoodleGradebookInPage } from "./moodle-gradebook-executor.js";
import { executeMoodleGradeReportSummaryInPage, executeMoodleLearnerGradeReportInPage } from "./moodle-grade-report-read.js";
import { executeMoodleCourseReportReadInPage } from "./moodle-reports-read.js";
import { executeMoodleSiteInventoryReadInPage } from "./moodle-site-inventory-read.js";
import { executeMoodleScormInPage } from "./moodle-scorm-executor.js";
import { executeMoodleH5pInPage } from "./moodle-h5p-executor.js";
import { executeMoodleScormAttemptSummaryInPage, executeMoodleScormLearnerReportInPage } from "./moodle-scorm-report-read.js";
import { executeMoodleAssignmentSubmissionSummaryInPage } from "./moodle-learner-submission-read.js";
import { executeMoodleAssignmentFeedbackInPage, executeMoodleAssignmentSubmissionInPage } from "./moodle-assignment-submission-read.js";
import { executeCanvasClassicQuizSubmissionSummaryInPage } from "./canvas-classic-quiz-submission-read.js";
import { executeCanvasCourseSummaryInPage } from "./canvas-course-summary-read.js";
import { executeMoodleActivityContentReadInPage } from "./moodle-activity-content-read.js";
import { executeMoodleActivityContentInPage } from "./moodle-activity-content-executor.js";
import { executeMoodleQuizAttemptSummaryInPage } from "./moodle-quiz-attempt-summary-read.js";
import { executeMoodleQuizAttemptInPage, executeMoodleQuizManualGradingQueueInPage, executeMoodleQuizRegradeReportInPage } from "./moodle-quiz-attempt-detail-read.js";
import { executeMoodleQuestionBankImpactScopeInPage } from "./moodle-question-impact-read.js";
import { executeMoodleLessonPageInPage, executeMoodleLessonPageListInPage } from "./moodle-lesson-read.js";
import { executeMoodleLessonPageWriteInPage } from "./moodle-lesson-executor.js";
import { executeMoodleQbankInPage } from "./moodle-qbank-executor.js";
import { executeMoodleQuizStructureInPage } from "./moodle-quiz-structure-executor.js";
import { executeMoodleActivityLifecycleInPage } from "./moodle-activity-lifecycle-executor.js";
import { executeMoodleSectionInPage } from "./moodle-section-executor.js";
import { executeMoodleQbankQuestionInPage } from "./moodle-qbank-question-executor.js";
import { executeMoodleWorkshopInPage } from "./moodle-workshop-executor.js";
import { executeMoodleLtiInPage } from "./moodle-lti-executor.js";
import { executeMoodleBigBlueButtonInPage } from "./moodle-bbb-executor.js";
import { executeMoodleSubsectionInPage } from "./moodle-subsection-executor.js";
import { executeMoodleBackupInPage } from "./moodle-backup-executor.js";
import { collectMoodleCourseParticipantRoster } from "./moodle-privacy.js";
import { CONVERSATIONAL_EDIT_DURATION_MS, EDIT_PERMISSION_SCHEMA, EDIT_POLICY_SELECTION_LIMIT, SETTINGS_EDIT_DURATIONS, categoriesForBinding, changedFields, createEditPermission, guardedItemBankUpdate, validEditDuration, validEditPermission } from "./edit-policy.js";
import { BridgeMaintenanceError, createBridgeMaintenance } from "./bridge-maintenance.js";
import { MAX_RENDER_CHECK_SOURCE_CHARS, RENDER_CHECK_MESSAGE_TYPE, RENDER_CHECK_SCHEMA, renderCheckField } from "../render-check/render-check.js";

const PORT = 32147;
const BRIDGE_PATH = "/morrow-bridge/v1";
const PROTOCOL_VERSION = 1;
const RUNTIME_REVISION = "1.0.0-rc.2";
const DISCOVERY_PAGE_LIMIT = 100;
const BRIDGE_BINDING_LIMIT = 500;
const USED_EFFECT_RECEIPT_LIMIT = 2_000;
const DISCOVERY_TTL_MS = 5 * 60 * 1_000;
const MAX_PRIVATE_FILE_BYTES = 1024 * 1024;
const MAX_PRIVATE_FILE_BASE64_BYTES = 4 * Math.ceil(MAX_PRIVATE_FILE_BYTES / 3);
const PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS = Object.freeze(["course_id", "section_id", "name", "filename", "size_bytes", "sha256", "expected_digest"]);
const PRIVATE_MOODLE_STAGED_REPLACE_ARGUMENTS = Object.freeze(["course_id", "module_id", "filename", "size_bytes", "sha256", "expected_digest"]);
const PRIVATE_MOODLE_STAGED_FILE_OPERATIONS = Object.freeze([
  Object.freeze({ toolName: "moodle_create_resource_file", key: "moodle.form.course.modedit.resource.file.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" }),
  Object.freeze({ toolName: "moodle_create_folder_file", key: "moodle.form.course.modedit.folder.file.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" }),
  Object.freeze({ toolName: "moodle_create_imscp_package", key: "moodle.form.course.modedit.imscp.package.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" }),
  Object.freeze({ toolName: "moodle_create_scorm_package", key: "moodle.form.course.modedit.scorm.package.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" }),
  Object.freeze({ toolName: "moodle_replace_resource_file", key: "moodle.form.course.modedit.resource.file.replace.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_REPLACE_ARGUMENTS, attachmentMode: "single" }),
  Object.freeze({ toolName: "moodle_replace_scorm_package", key: "moodle.form.course.modedit.scorm.package.replace.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_REPLACE_ARGUMENTS, attachmentMode: "single" }),
  Object.freeze({ toolName: "moodle_add_folder_files", key: "moodle.form.course.modedit.folder.files.add.write.v1", argumentNames: Object.freeze(["course_id", "module_id", "folder_path", "files", "expected_digest"]), attachmentMode: "multiple" }),
  Object.freeze({ toolName: "moodle_create_h5pactivity", key: "moodle.form.course.modedit.h5pactivity.create.write.v1", argumentNames: PRIVATE_MOODLE_STAGED_CREATE_ARGUMENTS, attachmentMode: "single" }),
]);
const PRIVATE_CANVAS_COURSE_FILE_TOOL = "canvas_transfer_course_file";
const PRIVATE_CANVAS_COURSE_FILE_OPERATION_KEY = "canvas.private.course_file.transfer.v1";
const PRIVATE_CANVAS_COURSE_FILE_ARGUMENTS = ["course_id", "folder_id", "filename", "size_bytes", "sha256", "content_type"];
const PRIVATE_CANVAS_COURSE_FILE_OPERATION = Object.freeze({
  key: PRIVATE_CANVAS_COURSE_FILE_OPERATION_KEY,
  toolName: PRIVATE_CANVAS_COURSE_FILE_TOOL,
  provider: "canvas",
  readOnly: false,
  service: "canvas_file_transfer",
  path: "/v1/courses/{course_id}/folders/{folder_id}/files",
});
const PRIVATE_CANVAS_CONVERSATION_OPERATION_RECORD = Object.freeze({
  key: PRIVATE_CANVAS_CONVERSATION_OPERATION,
  toolName: PRIVATE_CANVAS_CONVERSATION_TOOL,
  provider: "canvas",
  readOnly: false,
  service: "canvas_private_conversation",
  method: "POST",
  path: "/morrow/private/courses/{course_id}/conversations",
  resource: "Inbox",
  summary: "Send reviewed Canvas Inbox message",
  description: "Internal Morrow route for one reviewed Canvas Inbox conversation or reply.",
  morrowPrivate: true,
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({ course_id: Object.freeze({ type: "string", pattern: "^[1-9][0-9]*$" }) }),
    required: Object.freeze(["course_id"]),
    additionalProperties: false,
  }),
});
// The native course settings form. The format change is on the same form and
// in the same executor, because it reads and verifies the same protected
// course settings before it moves every section and activity.
const MOODLE_COURSE_SETTINGS_OPERATION_KEYS = new Set([
  "moodle.form.course.edit.settings.read.v1",
  "moodle.form.course.edit.settings.write.v1",
  "moodle.form.course.edit.format.write.v1",
]);
// Backup, restore, import and course copy. One executor holds all four because
// each is a multi-step native workflow over the same backup subsystem, and each
// step is dispatched once and read back before the next one is sent.
const MOODLE_BACKUP_OPERATION_KEYS = new Set([
  "moodle.form.backup.restorefile.index.read.v1",
  "moodle.ajax.core_backup.async_progress.backup.read.v1",
  "moodle.ajax.core_backup.async_progress.restore.read.v1",
  "moodle.form.backup.backup.course.write.v1",
  "moodle.form.backup.restore.course.write.v1",
  "moodle.form.backup.import.course.write.v1",
  "moodle.form.backup.copy.course.write.v1",
]);
// Activity completion and course completion. Both live in the same executor
// because both establish the same enrolled-participant count before a change
// and both refuse a native form whose completion settings Moodle has locked.
const MOODLE_COMPLETION_OPERATION_KEYS = new Set([
  "moodle.form.course.modedit.completion.read.v1",
  "moodle.form.course.modedit.completion.write.v1",
  "moodle.form.course.completion.read.v1",
  "moodle.form.course.completion.write.v1",
]);
// Access restrictions. One executor serves the activity form and the section
// form, because both keep the restriction tree in the same single native
// control and both replace the complete tree in one POST.
const MOODLE_RESTRICTIONS_OPERATION_KEYS = new Set([
  "moodle.form.course.modedit.restrictions.read.v1",
  "moodle.form.course.modedit.restrictions.write.v1",
  "moodle.form.course.editsection.restrictions.read.v1",
  "moodle.form.course.editsection.restrictions.write.v1",
]);
const MOODLE_GRADEBOOK_OPERATION_KEYS = new Set([
  "moodle.form.grade.tree.index.read.v1",
  "moodle.form.grade.tree.category.read.v1",
  "moodle.form.grade.tree.category.write.v1",
  "moodle.form.grade.tree.category.settings.write.v1",
  "moodle.form.grade.tree.item.read.v1",
  "moodle.form.grade.tree.item.write.v1",
  "moodle.form.grade.tree.item.settings.write.v1",
  "moodle.form.grade.scale.index.read.v1",
  "moodle.form.grade.outcome.index.read.v1",
  "moodle.form.grade.settings.index.read.v1",
]);
const MOODLE_SCORM_WRITE_OPERATIONS = new Map([
  ["moodle.form.course.modedit.scorm.write.v1", "moodle_update_scorm"],
  ["moodle.form.course.modedit.scorm.package.replace.write.v1", "moodle_replace_scorm_package"],
]);
// Moodle's own course reports. Four are aggregate; the participation report
// names the people it counted only when the request asks for it, and the MCP
// runtime projects those identities through the course participant roster.
const MOODLE_COURSE_REPORT_READ_OPERATIONS = new Map([
  ["moodle.form.report.activity.read.v1", { toolName: "moodle_get_course_activity_report", prefix: "moodle_course_activity_report" }],
  ["moodle.form.report.participation.read.v1", { toolName: "moodle_get_course_participation_report", prefix: "moodle_course_participation_report" }],
  ["moodle.form.report.completion.read.v1", { toolName: "moodle_get_course_completion_report", prefix: "moodle_course_completion_report" }],
  ["moodle.form.report.log_summary.read.v1", { toolName: "moodle_get_course_log_summary", prefix: "moodle_course_log_summary" }],
  ["moodle.form.report.dates.read.v1", { toolName: "moodle_get_course_dates_report", prefix: "moodle_course_dates_report" }],
]);
// Moodle's own system administration pages, read-only. Both reads fail closed
// when Moodle does not serve the administration page, and neither adds a write.
const MOODLE_SITE_ADMINISTRATION_READ_OPERATIONS = new Map([
  ["moodle.form.admin.site_inventory.read.v1", { toolName: "moodle_get_site_inventory", prefix: "moodle_site_inventory" }],
  ["moodle.form.admin.role_definitions.read.v1", { toolName: "moodle_get_role_definitions", prefix: "moodle_role_definitions" }],
]);
const MOODLE_ACTIVITY_CONTENT_READ_OPERATIONS = new Map([
  ["moodle.form.choice.options.read.v1", { toolName: "moodle_get_choice_options", prefix: "moodle_choice_options" }],
  ["moodle.form.choice.response_summary.read.v1", { toolName: "moodle_get_choice_response_summary", prefix: "moodle_choice_response_summary" }],
  ["moodle.form.feedback.items.read.v1", { toolName: "moodle_get_feedback_items", prefix: "moodle_feedback_items" }],
  ["moodle.form.feedback.response_summary.read.v1", { toolName: "moodle_get_feedback_response_summary", prefix: "moodle_feedback_response_summary" }],
  ["moodle.form.data.fields.read.v1", { toolName: "moodle_get_database_fields", prefix: "moodle_database_fields" }],
  ["moodle.form.data.entry_summary.read.v1", { toolName: "moodle_get_database_entry_summary", prefix: "moodle_database_entry_summary" }],
]);
// One child record of a Choice, a Feedback, or a Database. Each write reads
// the complete child list first, binds the exact record, refuses while the
// activity holds responses or entries, sends one POST, and reads the list back.
const MOODLE_ACTIVITY_CONTENT_WRITE_OPERATIONS = new Map([
  ["moodle.form.choice.option.write.v1", { toolName: "moodle_update_choice_option", prefix: "moodle_choice_option" }],
  ["moodle.form.feedback.item.create.write.v1", { toolName: "moodle_create_feedback_item", prefix: "moodle_feedback_item" }],
  ["moodle.form.feedback.item.write.v1", { toolName: "moodle_update_feedback_item", prefix: "moodle_feedback_item" }],
  ["moodle.form.data.field.create.write.v1", { toolName: "moodle_create_database_field", prefix: "moodle_database_field" }],
  ["moodle.form.data.field.write.v1", { toolName: "moodle_update_database_field", prefix: "moodle_database_field" }],
]);
const MOODLE_FORUM_EXPORT_OPERATION_KEY = "moodle.form.mod.forum.export.read.v1";
const MOODLE_GROUP_MAP_OPERATION_KEY = "moodle.page.group.membership_map.read.v1";
const MOODLE_COURSE_PARTICIPANTS_OPERATION_KEY = "moodle.form.enrol.participants.read.v1";
const MOODLE_ENROLMENT_METHODS_OPERATION_KEY = "moodle.form.enrol.methods.read.v1";
const MOODLE_PARTICIPANT_ENROLMENT_OPERATION_KEY = "moodle.form.enrol.participant.read.v1";
// Enrolment and role assignment are separate concepts in Moodle, so each of
// these five writes is its own operation with its own approval. Every one of
// them binds the person through the course participant roster inside the page.
const MOODLE_ENROLMENT_WRITE_OPERATIONS = new Map([
  ["moodle.form.enrol.participant.enrol.write.v1", "moodle_enrol_participant"],
  ["moodle.form.enrol.participant.suspend.write.v1", "moodle_suspend_participant"],
  ["moodle.form.enrol.participant.unenrol.write.v1", "moodle_unenrol_participant"],
  ["moodle.ajax.core_update_inplace_editable.user_roles.assign.v1", "moodle_assign_role"],
  ["moodle.ajax.core_update_inplace_editable.user_roles.remove.v1", "moodle_remove_role"],
]);
const MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_OPERATION_KEY = "moodle.form.assign.submissions.read.v1";
const MOODLE_ASSIGNMENT_SUBMISSION_OPERATION_KEY = "moodle.form.assign.submission.read.v1";
const MOODLE_ASSIGNMENT_FEEDBACK_OPERATION_KEY = "moodle.form.assign.feedback.read.v1";
const CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_OPERATION_KEY = "canvas.api.v1.course.quiz.submissions.aggregate.read.v1";
const CANVAS_COURSE_SUMMARY_OPERATIONS = new Map([
  ["canvas.api.v1.course.assignment.submissions.aggregate.read.v1", "canvas_get_assignment_submission_summary"],
  ["canvas.api.v1.course.gradebook.aggregate.read.v1", "canvas_get_course_gradebook_summary"],
  ["canvas.api.v1.course.activity.aggregate.read.v1", "canvas_get_course_activity_summary"],
]);
const MOODLE_QUIZ_ATTEMPT_SUMMARY_OPERATION_KEY = "moodle.form.quiz.attempt_summary.read.v1";
const MOODLE_QUIZ_ATTEMPT_DETAIL_OPERATION_KEY = "moodle.form.quiz.attempt_detail.read.v1";
const MOODLE_QUIZ_MANUAL_GRADING_QUEUE_OPERATION_KEY = "moodle.form.quiz.manual_grading_queue.read.v1";
const MOODLE_QUIZ_REGRADE_REPORT_OPERATION_KEY = "moodle.form.quiz.regrade_report.read.v1";
const MOODLE_FORUM_ACTIVITY_SUMMARY_OPERATION_KEY = "moodle.form.forum.activity_summary.read.v1";
const MOODLE_SCORM_ATTEMPT_SUMMARY_OPERATION_KEY = "moodle.form.scorm.attempt_summary.read.v1";
const MOODLE_SCORM_LEARNER_REPORT_OPERATION_KEY = "moodle.form.scorm.learner_report.read.v1";
const MOODLE_GRADE_REPORT_SUMMARY_OPERATION_KEY = "moodle.form.grade.report.summary.read.v1";
const MOODLE_LEARNER_GRADE_REPORT_OPERATION_KEY = "moodle.form.grade.report.learner.read.v1";
const MOODLE_QUESTION_BANK_IMPACT_SCOPE_OPERATION_KEY = "moodle.form.question.bank.impact_scope.read.v1";
const MOODLE_LESSON_PAGE_LIST_OPERATION_KEY = "moodle.form.lesson.pages.read.v1";
const MOODLE_LESSON_PAGE_OPERATION_KEY = "moodle.form.lesson.page.read.v1";
// Add, rewrite, move, and delete one page of one Lesson. Each one reads the
// complete page graph, acts once, and requires that graph back.
const MOODLE_LESSON_PAGE_WRITE_OPERATION_KEYS = new Set([
  "moodle.form.lesson.page.create.v1",
  "moodle.form.lesson.page.update.v1",
  "moodle.form.lesson.page.move.v1",
  "moodle.form.lesson.page.delete.v1",
]);
// Forum discussion and post lifecycle. One executor holds the posting target
// read and every change to a discussion, because each one binds the same Forum
// through the same native course/modedit.php form.
const MOODLE_FORUM_POST_OPERATION_KEYS = new Set([
  "moodle.form.forum.post_target.read.v1",
  "moodle.form.forum.discussion.create.write.v1",
  "moodle.form.forum.post.reply.write.v1",
  "moodle.form.forum.discussion.lock.write.v1",
  "moodle.form.forum.discussion.pin.write.v1",
  "moodle.form.forum.discussion.subscription.write.v1",
]);
// The group and grouping lifecycle of one course, and the group mode of one
// activity in it. One executor holds them because each one binds the same
// course through Moodle's own group-management routes.
const MOODLE_GROUPS_LIFECYCLE_OPERATION_KEYS = new Set([
  "moodle.page.group.groupings.read.v1",
  "moodle.form.group.create.v1",
  "moodle.form.group.update.v1",
  "moodle.form.group.delete.v1",
  "moodle.form.group.member.add.v1",
  "moodle.form.group.member.remove.v1",
  "moodle.form.grouping.create.v1",
  "moodle.form.grouping.update.v1",
  "moodle.form.grouping.groups.set.v1",
  "moodle.ajax.core_courseformat_update_course.cm_groupmode.v1",
]);
// Glossary entries and Wiki pages. One executor holds both, because each
// operation binds its activity through the same native course/modedit.php form
// and then reads or writes one child record of it.
const MOODLE_GLOSSARY_WIKI_OPERATION_KEYS = new Set([
  "moodle.form.glossary.entries.read.v1",
  "moodle.form.glossary.entry.read.v1",
  "moodle.form.glossary.entry.create.write.v1",
  "moodle.form.glossary.entry.update.write.v1",
  "moodle.form.wiki.pages.read.v1",
  "moodle.form.wiki.page.read.v1",
  "moodle.form.wiki.page.update.write.v1",
]);
// The External tool route. It reads and writes activity settings only. It never
// launches the tool, never runs deep linking, and never carries a consumer key
// or a shared secret out of the page.
const MOODLE_LTI_OPERATION_KEYS = new Set([
  "moodle.form.course.modedit.lti.read.v1",
  "moodle.form.course.modedit.lti.create.read.v1",
  "moodle.form.course.modedit.lti.create.write.v1",
  "moodle.form.course.modedit.lti.write.v1",
]);
// The BigBlueButton route. It reads activity and creation settings and creates
// one hidden room with its schedule. Morrow performs no BigBlueButton server
// action: it never joins, starts or ends a meeting, never asks for a recording,
// and opens no /mod/bigbluebuttonbn page.
const MOODLE_BIGBLUEBUTTON_OPERATION_KEYS = new Set([
  "moodle.form.course.modedit.bigbluebuttonbn.read.v1",
  "moodle.form.course.modedit.bigbluebuttonbn.create.read.v1",
  "moodle.form.course.modedit.bigbluebuttonbn.create.write.v1",
]);
// The H5P activity route. It reads activity and creation settings, creates one
// hidden activity from one reviewed .h5p package, and edits bounded settings.
// It never opens /mod/h5pactivity/view.php, an attempt report, or the H5P
// player, and it refuses a form whose package comes from the content bank.
const MOODLE_H5P_OPERATION_KEYS = new Set([
  "moodle.form.course.modedit.h5pactivity.read.v1",
  "moodle.form.course.modedit.h5pactivity.create.read.v1",
  "moodle.form.course.modedit.h5pactivity.create.write.v1",
  "moodle.form.course.modedit.h5pactivity.write.v1",
]);
// Phase one of the hidden Question bank isolation route: create the activity,
// then realize its default category as a separate approved change.
const MOODLE_QBANK_OPERATION_KEYS = new Set([
  "moodle.form.course.modedit.qbank.create.read.v1",
  "moodle.form.course.modedit.qbank.create.write.v1",
  "moodle.form.course.modedit.qbank.read.v1",
  "moodle.form.question.bank.default_category.realize.write.v1",
]);
// Phase two of the same route: create one new question in that bank category,
// then add that one entry to the approved Quiz as a separate approved change.
const MOODLE_QBANK_QUESTION_OPERATION_KEYS = new Set([
  "moodle.form.question.bank.editquestion.create.read.v1",
  "moodle.form.question.bank.editquestion.create.write.v1",
  "moodle.form.mod.quiz.qbank_question.add.read.v1",
  "moodle.form.mod.quiz.qbank_question.add.write.v1",
]);
// The Quiz slot layout and the four changes to it. None of them reaches a
// Question bank entry.
const MOODLE_QUIZ_STRUCTURE_OPERATION_KEYS = new Set([
  "moodle.form.mod.quiz.edit.structure.read.v1",
  "moodle.form.mod.quiz.edit.slot.move.write.v1",
  "moodle.form.mod.quiz.edit.slot.maxmark.write.v1",
  "moodle.form.mod.quiz.edit.slot.pagebreak.write.v1",
  "moodle.form.mod.quiz.edit.slot.remove.write.v1",
]);
// Copy, remove, and exact placement for one activity. Each one reads the
// complete course state, acts once, and requires that state back.
const MOODLE_ACTIVITY_LIFECYCLE_OPERATION_KEYS = new Set([
  "moodle.ajax.core_courseformat_update_course.cm_duplicate.v1",
  "moodle.ajax.core_courseformat_update_course.cm_delete.v1",
  "moodle.ajax.core_courseformat_update_course.cm_move_to_position.v1",
]);
// Add, remove, and exact placement for one course section. Each one reads the
// complete course state and the course format, acts once, and requires that
// state back with the format unchanged.
const MOODLE_SECTION_OPERATION_KEYS = new Set([
  "moodle.ajax.core_courseformat_update_course.section_add.v1",
  "moodle.ajax.core_courseformat_update_course.section_delete.v1",
  "moodle.ajax.core_courseformat_update_course.section_move_after.v1",
]);
// The calendar of one course. Every one of them states the civil time zone it
// read or wrote a wall-clock date in, and converts none.
const MOODLE_CALENDAR_OPERATION_KEYS = new Set([
  "moodle.ajax.core_calendar.course_events.read.v1",
  "moodle.ajax.core_calendar.course_dates.read.v1",
  "moodle.ajax.core_calendar.event.read.v1",
  "moodle.ajax.core_calendar.event_create.write.v1",
  "moodle.ajax.core_calendar.event_update.write.v1",
  "moodle.ajax.core_calendar.event_delete.write.v1",
]);
// One Moodle Subsection, the activities it holds, and one hidden create. Each
// one reads the complete subsection pairing of the course before it answers.
const MOODLE_SUBSECTION_OPERATION_KEYS = new Set([
  "moodle.state.subsection.read.v1",
  "moodle.state.subsection.contents.read.v1",
  "moodle.form.course.modedit.subsection.create.write.v1",
]);
// The Workshop settings read, its creation form, one hidden create, a bounded
// settings change, and the stored phase. None of them changes a phase, and none
// of them opens /mod/workshop/view.php.
const MOODLE_WORKSHOP_OPERATION_KEYS = new Set([
  "moodle.form.course.modedit.workshop.read.v1",
  "moodle.form.course.modedit.workshop.create.read.v1",
  "moodle.form.course.modedit.workshop.create.write.v1",
  "moodle.form.course.modedit.workshop.write.v1",
  "moodle.form.workshop.phase.read.v1",
]);
const RENDER_CHECK_DOCUMENT_PATH = "render-check/render-check-host.html";
const RENDER_CHECK_IDLE_MS = 30_000;
let renderCheckDocument = null;
let renderCheckIdleTimer = null;
const COURSE_FILE_STORAGE_ACCESS_KEY = "courseFileStorageAccessEnabled";
const COURSE_FILE_STORAGE_ORIGINS = Object.freeze(["https://*/*"]);
const COURSE_FILE_READ_TIMEOUT_MS = 30_000;
const COURSE_CONNECTION_INTENT_KEY = "pendingCourseConnection";
const COURSE_CONNECTION_INTENT_TTL_MS = 60_000;
// How long one confirmed course-site match is kept for reads and status. Short enough that a person
// who signs out or moves that tab waits about a second for Morrow to notice, and long enough that a
// burst of reads against one course site shares one page round trip. Writes never read it.
const ANCHOR_VERIFICATION_TTL_MS = 2_000;
const SETUP_GUIDE_PATH = "onboarding/onboarding.html";
const CANVAS_CONTENT_GUARD_OPERATIONS = Object.freeze([
  Object.freeze({ kind: "page_text", toolName: "canvas_update_create_page_courses", key: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses" }),
  Object.freeze({ kind: "page_image_alt", toolName: "canvas_update_create_page_courses", key: "PUT /v1/courses/{course_id}/pages/{url_or_id}#update_create_page_courses" }),
  Object.freeze({ kind: "assignment_image_alt", toolName: "canvas_edit_assignment", key: "PUT /v1/courses/{course_id}/assignments/{id}#edit_assignment" }),
  Object.freeze({ kind: "discussion_image_alt", toolName: "canvas_update_topic_courses", key: "PUT /v1/courses/{course_id}/discussion_topics/{topic_id}#update_topic_courses" }),
  Object.freeze({ kind: "classic_quiz_description_image_alt", toolName: "canvas_edit_quiz", key: "PUT /v1/courses/{course_id}/quizzes/{id}#edit_quiz" }),
  Object.freeze({ kind: "classic_quiz_question_image_alt", toolName: "canvas_update_existing_quiz_question", key: "PUT /v1/courses/{course_id}/quizzes/{quiz_id}/questions/{id}#update_existing_quiz_question" }),
  Object.freeze({ kind: "new_quiz_item_image_alt", toolName: "canvas_update_quiz_item", key: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item" }),
  Object.freeze({ kind: "new_quiz_choice_image_alt", toolName: "canvas_update_quiz_item", key: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item" }),
  Object.freeze({ kind: "new_quiz_answer_feedback_image_alt", toolName: "canvas_update_quiz_item", key: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item" }),
  Object.freeze({ kind: "new_quiz_feedback_image_alt", toolName: "canvas_update_quiz_item", key: "PATCH /quiz/v1/courses/{course_id}/quizzes/{assignment_id}/items/{item_id}#update_quiz_item" }),
]);
const state = { socket: null, generation: 0, accepted: null, catalog: null, operations: new Map(), reconnectTimer: null, writeQueues: new Map(), storageQueue: Promise.resolve() };
const canvasUploadObservers = new Map();
// siteAnchorId -> the last course-site match, or the probe that is finding one now.
const anchorVerifications = new Map();
const bridgeMaintenance = createBridgeMaintenance();

async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function responseContentType(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
}

function exactCourseFileReadArguments(args, binding) {
  if (!args || typeof args !== "object" || Array.isArray(args)
    || Object.keys(args).length !== 2 || !Object.hasOwn(args, "course_id") || !Object.hasOwn(args, "file_id")) return null;
  const courseId = decimalId(args.course_id);
  const fileId = decimalId(args.file_id);
  return courseId && courseId === binding.courseId && fileId ? { courseId, fileId } : null;
}

function sameCourseFileVersion(left, right) {
  return left && right
    && left.id === right.id
    && left.size === right.size
    && left.content_type === right.content_type
    && left.updated_at === right.updated_at
    && left.modified_at === right.modified_at;
}

async function courseFileStorageAccessEnabled() {
  const stored = await chrome.storage.local.get(COURSE_FILE_STORAGE_ACCESS_KEY);
  if (stored[COURSE_FILE_STORAGE_ACCESS_KEY] !== true) return false;
  return await chrome.permissions.contains({ origins: COURSE_FILE_STORAGE_ORIGINS }).catch(() => false);
}

async function boundedResponseBytes(response, limit, signal) {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > limit)) {
    throw new Error("canvas_file_content_too_large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("canvas_file_content_timeout");
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("canvas_file_content_stream_invalid");
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel("canvas_file_content_too_large");
        throw new Error("canvas_file_content_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The one bounded course-file byte read. Both file routes use it, so the text
 * route and the structural signal route share exactly the same boundary: the
 * user's file-access opt-in, fresh course-scoped metadata read in the bound
 * Canvas tab, a supported declared type, the 1 MiB cap, one credential-free
 * fetch of the canonical download URL, an exact byte-length match, the SHA-256
 * digest of those bytes, and a second fresh metadata read that must return the
 * same file version. The signed download URL never leaves this function.
 */
async function readCanvasCourseFileBytes(binding, fileId, expiresAt, contentTypeSupported) {
  if (!await courseFileStorageAccessEnabled()) return { ok: false, sent: false, error: "canvas_file_storage_access_required" };
  const deadline = Math.min(
    Number.isSafeInteger(expiresAt) && expiresAt > Date.now() ? expiresAt : Date.now() + COURSE_FILE_READ_TIMEOUT_MS,
    Date.now() + COURSE_FILE_READ_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  try {
    const pageInput = {
      binding: { courseId: binding.courseId, origin: binding.origin, principalId: binding.principalId },
      fileId,
      includeDownloadUrl: true,
    };
    const [preparedExecution] = await chrome.scripting.executeScript({
      target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeCanvasCourseFileTextInPage, args: [pageInput],
    });
    const prepared = preparedExecution?.result;
    if (!prepared?.ok || !prepared.version || !prepared.file || typeof prepared.downloadUrl !== "string") {
      return { ok: false, sent: false, error: prepared?.error || "canvas_file_metadata_unavailable" };
    }
    if (!contentTypeSupported(prepared.version.content_type)) {
      return { ok: false, sent: false, error: "canvas_file_content_type_unsupported" };
    }
    if (!Number.isSafeInteger(prepared.version.size) || prepared.version.size < 0 || prepared.version.size > MAX_FILE_TEXT_BYTES) {
      return { ok: false, sent: false, error: "canvas_file_content_too_large" };
    }
    const response = await fetch(prepared.downloadUrl, {
      credentials: "omit",
      redirect: "follow",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    let finalUrl;
    try { finalUrl = new URL(response.url); } catch { return { ok: false, sent: true, error: "canvas_file_final_url_invalid" }; }
    if (!response.ok || finalUrl.protocol !== "https:") return { ok: false, sent: true, status: response.status, error: "canvas_file_content_fetch_failed" };
    if (responseContentType(response.headers.get("content-type")) !== prepared.version.content_type) {
      return { ok: false, sent: true, status: response.status, error: "canvas_file_content_type_mismatch" };
    }
    const bytes = await boundedResponseBytes(response, MAX_FILE_TEXT_BYTES, controller.signal);
    if (bytes.byteLength !== prepared.version.size) return { ok: false, sent: true, status: response.status, error: "canvas_file_content_size_mismatch" };
    const digest = await sha256Bytes(bytes);
    const [verificationExecution] = await chrome.scripting.executeScript({
      target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeCanvasCourseFileTextInPage,
      args: [{ ...pageInput, includeDownloadUrl: false }],
    });
    const verified = verificationExecution?.result;
    if (!verified?.ok || !sameCourseFileVersion(prepared.version, verified.version)) {
      return { ok: false, sent: true, status: response.status, error: verified?.error || "canvas_file_changed_during_read" };
    }
    return { ok: true, sent: true, status: response.status, version: prepared.version, file: prepared.file, bytes, digest };
  } catch (error) {
    return { ok: false, sent: false, error: controller.signal.aborted ? "canvas_file_content_timeout" : String(error?.message || error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function executeCanvasCourseFileText(binding, operation, args, expiresAt) {
  const requested = exactCourseFileReadArguments(args, binding);
  if (operation?.key !== "CANVAS_COURSE_FILE_TEXT GET /v1/courses/{course_id}/files/{file_id}/text"
    || operation?.toolName !== "canvas_read_course_file_text" || operation?.readOnly !== true || !requested) {
    return { ok: false, sent: false, error: "canvas_file_text_arguments_invalid" };
  }
  const read = await readCanvasCourseFileBytes(binding, requested.fileId, expiresAt, canvasFileTextContentTypeSupported);
  if (!read.ok) return read;
  let content;
  try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes); } catch { return { ok: false, sent: true, status: read.status, error: "canvas_file_content_utf8_invalid" }; }
  return {
    schema: "morrow.canvas-course-file-text.v1", ok: true, sent: true, status: read.status, truncated: false,
    data: { ...read.file, content, content_sha256: read.digest, content_byte_length: read.bytes.byteLength }, snapshot_digest: read.digest,
  };
}

/**
 * The same bounded read for a PDF or Office document, returning structural
 * signals only. The bytes stay inside this worker: the result carries counts,
 * presence states, one language-value length, and the digest of the bytes those
 * signals came from. A structure the reader cannot parse refuses the read.
 */
async function executeCanvasCourseFileSignals(binding, operation, args, expiresAt) {
  const requested = exactCourseFileReadArguments(args, binding);
  if (operation?.key !== CANVAS_FILE_SIGNALS_OPERATION_KEY || operation?.toolName !== CANVAS_FILE_SIGNALS_TOOL_NAME
    || operation?.readOnly !== true || !requested) {
    return { ok: false, sent: false, error: "canvas_file_signals_arguments_invalid" };
  }
  const read = await readCanvasCourseFileBytes(binding, requested.fileId, expiresAt, canvasFileSignalsContentTypeSupported);
  if (!read.ok) return read;
  const signals = await canvasCourseFileSignals(read.bytes, read.version.content_type);
  if (!signals.ok) return { ok: false, sent: true, status: read.status, error: signals.error };
  return {
    schema: CANVAS_FILE_SIGNALS_SCHEMA, ok: true, sent: true, status: read.status, truncated: false,
    data: { ...read.file, content_sha256: read.digest, content_byte_length: read.bytes.byteLength, file_signals: signals.signals },
    snapshot_digest: read.digest,
  };
}

async function catalog() {
  if (state.catalog) return state.catalog;
  const response = await fetch(chrome.runtime.getURL("generated/canvas-api-catalog.json"));
  const value = await response.json();
  if (value?.schema !== "morrow.canvas-api-catalog.v1" || !Array.isArray(value.operations)) throw new Error("connector_catalog_invalid");
  const canvasBrowserResponse = await fetch(chrome.runtime.getURL("generated/canvas-browser-catalog.json"));
  const canvasBrowserText = await canvasBrowserResponse.text();
  const canvasBrowser = JSON.parse(canvasBrowserText);
  if (canvasBrowser.schema !== "morrow.browser-catalog.v1" || canvasBrowser.provider !== "canvas" || !Array.isArray(canvasBrowser.operations)
    || canvasBrowser.operations.some((operation) => operation.provider !== "canvas" || !operation.toolName.startsWith("canvas_"))) throw new Error("connector_catalog_invalid");
  const moodleResponse = await fetch(chrome.runtime.getURL("generated/moodle-browser-catalog.json"));
  const moodleText = await moodleResponse.text();
  const moodle = JSON.parse(moodleText);
  if (moodle.schema !== "morrow.browser-catalog.v1" || moodle.provider !== "moodle" || !Array.isArray(moodle.operations)
    || moodle.operations.some((operation) => operation.provider !== "moodle" || !operation.toolName.startsWith("moodle_"))) throw new Error("connector_catalog_invalid");
  state.catalog = { ...value, catalogDigest: await sha256(`${value.catalogDigest}\n${await sha256(canvasBrowserText)}\n${await sha256(moodleText)}`) };
  const operations = [
    ...value.operations.map((operation) => ({ ...operation, provider: "canvas" })),
    ...canvasBrowser.operations,
    ...moodle.operations,
    PRIVATE_CANVAS_CONVERSATION_OPERATION_RECORD,
  ];
  state.operations = new Map(operations.map((operation) => [operation.toolName, operation]));
  if (state.operations.size !== operations.length) throw new Error("connector_catalog_invalid");
  return state.catalog;
}

function bridgeUrl() {
  return `ws://127.0.0.1:${PORT}${BRIDGE_PATH}`;
}

function httpUrl(path = "") {
  return `http://127.0.0.1:${PORT}${BRIDGE_PATH}${path}`;
}

async function storage() {
  return await chrome.storage.local.get(["token", "bindings", "pairing", "siteAnchors", "editPolicies", "editPolicyRevisions"]);
}

function discoveryArea() {
  return chrome.storage.session || chrome.storage.local;
}

async function discoveries() {
  return await discoveryArea().get("courseDiscoveries");
}

function queueStorageMutation(work) {
  const queued = state.storageQueue.catch(() => undefined).then(work);
  state.storageQueue = queued.catch(() => undefined);
  return queued;
}

function queueBindingWrite(sourceBindingId, work) {
  const queued = (state.writeQueues.get(sourceBindingId) || Promise.resolve()).catch(() => undefined).then(work);
  const settled = queued.finally(() => {
    if (state.writeQueues.get(sourceBindingId) === settled) state.writeQueues.delete(sourceBindingId);
  });
  state.writeQueues.set(sourceBindingId, settled);
  return settled;
}

function storedPolicies(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function storedPolicyRevisions(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function storedAnchors(value) {
  return Array.isArray(value) ? value : [];
}

function storedDiscoveries(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function decimalId(value) {
  const id = String(value || "");
  return /^[1-9][0-9]*$/.test(id) ? id : "";
}

function privateFilename(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 255 && value === value.trim()
    && value !== "." && value !== ".." && !/[\\/\u0000-\u001f]/.test(value)
    ? value
    : "";
}

function privateMoodleStagedFileOperation(operation) {
  return operation?.provider === "moodle"
    ? PRIVATE_MOODLE_STAGED_FILE_OPERATIONS.find(({ toolName, key }) => operation?.toolName === toolName && operation?.key === key) || null
    : null;
}

function privateCanvasCourseFileOperation(operation) {
  return operation?.provider === "canvas"
    && operation?.toolName === PRIVATE_CANVAS_COURSE_FILE_TOOL
    && operation?.key === PRIVATE_CANVAS_COURSE_FILE_OPERATION_KEY
    && operation?.service === "canvas_file_transfer";
}

function privateCanvasCourseFileCommand(command) {
  return command?.kind === "invoke_write"
    && command?.toolName === PRIVATE_CANVAS_COURSE_FILE_TOOL
    && command?.operationKey === PRIVATE_CANVAS_COURSE_FILE_OPERATION_KEY
    ? PRIVATE_CANVAS_COURSE_FILE_OPERATION
    : null;
}

async function privateMoodleAttachment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["schema", "handle", "manifest", "bytes_base64"].includes(key))
    || value.schema !== "morrow.private-file-attachment.v1"
    || typeof value.handle !== "string" || !/^file:[A-Za-z0-9_.:-]{1,160}$/.test(value.handle)
    || typeof value.bytes_base64 !== "string" || value.bytes_base64.length < 4 || value.bytes_base64.length > MAX_PRIVATE_FILE_BASE64_BYTES
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bytes_base64)
    || !value.manifest || typeof value.manifest !== "object" || Array.isArray(value.manifest)
    || Object.keys(value.manifest).some((key) => !["filename", "size_bytes", "sha256"].includes(key))) return null;
  const manifest = {
    filename: privateFilename(value.manifest.filename),
    size_bytes: value.manifest.size_bytes,
    sha256: value.manifest.sha256,
  };
  if (!manifest.filename || !Number.isSafeInteger(manifest.size_bytes) || manifest.size_bytes < 1 || manifest.size_bytes > MAX_PRIVATE_FILE_BYTES
    || typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) return null;
  let binary;
  try { binary = atob(value.bytes_base64); } catch { return null; }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== manifest.size_bytes || bytes.byteLength > MAX_PRIVATE_FILE_BYTES) return null;
  try {
    if (await sha256Bytes(bytes) !== manifest.sha256) return null;
  } catch { return null; }
  return {
    schema: "morrow.private-file-attachment.v1",
    handle: value.handle,
    manifest,
    bytes_base64: value.bytes_base64,
  };
}

async function privateMoodleAttachments(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null;
  const attachments = [];
  for (const entry of value) {
    const attachment = await privateMoodleAttachment(entry);
    if (!attachment) return null;
    attachments.push(attachment);
  }
  if (attachments.reduce((total, attachment) => total + attachment.manifest.size_bytes, 0) > MAX_PRIVATE_FILE_BYTES
    || new Set(attachments.map((attachment) => attachment.handle)).size !== attachments.length
    || new Set(attachments.map((attachment) => attachment.manifest.filename)).size !== attachments.length) return null;
  return attachments;
}

async function privateCanvasAttachment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["schema", "handle", "manifest", "bytes_base64", "content_type"].includes(key))
    || value.schema !== "morrow.private-file-attachment.v1"
    || typeof value.handle !== "string" || !/^file:[A-Za-z0-9_.:-]{1,160}$/.test(value.handle)
    || typeof value.content_type !== "string" || !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(value.content_type)
    || typeof value.bytes_base64 !== "string" || value.bytes_base64.length < 4 || value.bytes_base64.length > MAX_PRIVATE_FILE_BASE64_BYTES
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.bytes_base64)
    || !value.manifest || typeof value.manifest !== "object" || Array.isArray(value.manifest)
    || Object.keys(value.manifest).some((key) => !["filename", "size_bytes", "sha256"].includes(key))) return null;
  const manifest = {
    filename: privateFilename(value.manifest.filename),
    size_bytes: value.manifest.size_bytes,
    sha256: value.manifest.sha256,
  };
  if (!manifest.filename || !Number.isSafeInteger(manifest.size_bytes) || manifest.size_bytes < 1 || manifest.size_bytes > MAX_PRIVATE_FILE_BYTES
    || typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) return null;
  let binary;
  try { binary = atob(value.bytes_base64); } catch { return null; }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== manifest.size_bytes || bytes.byteLength > MAX_PRIVATE_FILE_BYTES) return null;
  try {
    if (await sha256Bytes(bytes) !== manifest.sha256) return null;
  } catch { return null; }
  return {
    schema: "morrow.private-file-attachment.v1",
    handle: value.handle,
    manifest,
    bytes_base64: value.bytes_base64,
    content_type: value.content_type,
  };
}

function privateMoodleAttachmentMatches(argumentsValue, attachment, argumentNames) {
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)
    || Object.keys(argumentsValue).length !== argumentNames.length
    || argumentNames.some((key) => !Object.hasOwn(argumentsValue, key))) return false;
  return argumentNames.filter((key) => key.endsWith("_id")).every((key) => decimalId(argumentsValue[key]) !== "")
    && (!argumentNames.includes("name") || (typeof argumentsValue.name === "string" && argumentsValue.name.length >= 1 && argumentsValue.name.length <= 1333))
    && argumentsValue.filename === attachment.manifest.filename
    && argumentsValue.size_bytes === attachment.manifest.size_bytes
    && argumentsValue.sha256 === attachment.manifest.sha256
    && typeof argumentsValue.expected_digest === "string" && /^[a-f0-9]{64}$/.test(argumentsValue.expected_digest);
}

function privateMoodleAttachmentsMatch(argumentsValue, attachments, argumentNames) {
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)
    || Object.keys(argumentsValue).length !== argumentNames.length
    || argumentNames.some((key) => !Object.hasOwn(argumentsValue, key))
    || !Array.isArray(argumentsValue.files) || argumentsValue.files.length !== attachments.length
    || typeof argumentsValue.folder_path !== "string" || !/^\/(?:[^\\/]+\/)*$/.test(argumentsValue.folder_path)
    || !argumentNames.filter((key) => key.endsWith("_id")).every((key) => decimalId(argumentsValue[key]) !== "")
    || typeof argumentsValue.expected_digest !== "string" || !/^[a-f0-9]{64}$/.test(argumentsValue.expected_digest)) return false;
  return argumentsValue.files.every((file, index) => file && typeof file === "object" && !Array.isArray(file)
    && Object.keys(file).length === 3
    && file.filename === attachments[index]?.manifest.filename
    && file.size_bytes === attachments[index]?.manifest.size_bytes
    && file.sha256 === attachments[index]?.manifest.sha256);
}

function privateCanvasAttachmentMatches(argumentsValue, attachment) {
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)
    || Object.keys(argumentsValue).length !== PRIVATE_CANVAS_COURSE_FILE_ARGUMENTS.length
    || PRIVATE_CANVAS_COURSE_FILE_ARGUMENTS.some((key) => !Object.hasOwn(argumentsValue, key))) return false;
  return decimalId(argumentsValue.course_id) !== "" && decimalId(argumentsValue.folder_id) !== ""
    && argumentsValue.filename === attachment.manifest.filename
    && argumentsValue.size_bytes === attachment.manifest.size_bytes
    && argumentsValue.sha256 === attachment.manifest.sha256
    && argumentsValue.content_type === attachment.content_type;
}

function anchorForBinding(binding, anchors) {
  return storedAnchors(anchors).find((anchor) => anchor.siteAnchorId === binding.siteAnchorId) || null;
}

function materializeBinding(binding, anchor) {
  return anchor ? { ...binding, tabId: anchor.tabId } : binding;
}

async function editPermissionFor(binding, stored, api) {
  return await validEditPermission({ permission: storedPolicies(stored.editPolicies)[binding.sourceBindingId], binding, catalogDigest: api.catalogDigest, operations: [...state.operations.values()] });
}

function stalePermissionSummary(permission, binding, catalogDigest, operations) {
  const available = new Set(categoriesForBinding(binding, operations).filter((category) => category.availability === "edit").map((category) => category.id));
  const expiresAt = Number.isSafeInteger(permission?.expiresAt) ? permission.expiresAt : undefined;
  const expired = expiresAt !== undefined && expiresAt <= Date.now();
  if (!permission || typeof permission !== "object" || permission.schema !== EDIT_PERMISSION_SCHEMA
    || permission.sourceBindingId !== binding.sourceBindingId || !Number.isSafeInteger(permission.revision) || permission.revision < 1
    || !/^[0-9a-f]{64}$/.test(permission.catalogDigest || "") || (permission.catalogDigest === catalogDigest && !expired)
    || !Array.isArray(permission.enabledCategories) || !permission.enabledCategories.length
    || new Set(permission.enabledCategories).size !== permission.enabledCategories.length
    || permission.enabledCategories.some((category) => typeof category !== "string" || !available.has(category))) return null;
  return {
    schema: permission.schema,
    revision: permission.revision,
    catalogDigest: permission.catalogDigest,
    sourceBindingId: permission.sourceBindingId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function sameSitePrincipal(left, right) {
  return left.provider === right.provider
    && left.origin === right.origin
    && (left.siteUrl || "") === (right.siteUrl || "")
    && left.principalFingerprint === right.principalFingerprint;
}

async function publicBindings() {
  const api = await catalog();
  const stored = await storage();
  const anchors = storedAnchors(stored.siteAnchors);
  const policies = storedPolicies(stored.editPolicies);
  const revisions = storedPolicyRevisions(stored.editPolicyRevisions);
  const verified = new Map(await Promise.all(anchors.map(async (anchor) => [anchor.siteAnchorId, await siteAnchorMatches(anchor)])));
  return await Promise.all((stored.bindings || []).map(async ({ principalId: _principalId, siteAnchorId: _siteAnchorId, ...binding }) => {
    const anchor = anchorForBinding({ ...binding, siteAnchorId: _siteAnchorId }, anchors);
    const privateBinding = materializeBinding({ ...binding, siteAnchorId: _siteAnchorId, principalId: _principalId }, anchor);
    const editPermission = await editPermissionFor(privateBinding, stored, api);
    const editPolicyRevision = Math.max(Number.isSafeInteger(revisions[binding.sourceBindingId]) ? revisions[binding.sourceBindingId] : 0, Number.isSafeInteger(policies[binding.sourceBindingId]?.revision) ? policies[binding.sourceBindingId].revision : 0);
    return {
      ...binding,
      catalogDigest: api.catalogDigest,
      editPolicyRevision,
      editOptionsAvailable: true,
      ...(editPermission ? { editPermission: editPermissionSummary(editPermission) } : {}),
      runtimeVerified: binding.runtimeVerified && verified.get(_siteAnchorId) === true,
    };
  }));
}

/** One probe: it injects into the course tab and waits for the page to name its signed-in account. */
async function probeSiteAnchor(anchor, tab) {
  const url = new URL(tab.url);
  if (anchor.provider === "moodle") {
    if (url.origin !== anchor.origin) return false;
    const [probe] = await chrome.scripting.executeScript({ target: { tabId: anchor.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleInPage, args: [JSON.stringify({ mode: "probe" })] }).catch(() => []);
    const profile = probe?.result?.profile;
    return probe?.result?.ok === true && profile?.siteUrl === anchor.siteUrl && profile.principalId === anchor.principalId;
  }
  if (anchor.provider !== "canvas" || url.origin !== anchor.origin) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId: anchor.tabId, frameIds: [0] }, files: ["src/canvas-content.js"] });
    const probe = await chrome.tabs.sendMessage(anchor.tabId, { type: "morrow_canvas_probe" }, { frameId: 0 });
    return probe?.ok === true && probe.profile?.origin === anchor.origin && probe.profile?.id === anchor.principalId;
  } catch {
    return false;
  }
}

/**
 * Every command used to pay for its own probe, so a batch of reads against one course site ran one
 * page round trip each and one navigation in that tab failed all of them. This keeps a match for
 * ANCHOR_VERIFICATION_TTL_MS and shares one in-flight probe between callers that arrive together.
 *
 * The rules the cache keeps, in order:
 * - The tab is read every time. A closed tab is refused here, before any probe.
 * - A kept match belongs to one exact tab URL. A different URL probes again.
 * - A refusal is never kept. The next caller probes again.
 * - Every write asks with `fresh`, so the fence immediately before a change is one live probe.
 */
async function siteAnchorMatches(anchor, { fresh = false } = {}) {
  const siteAnchorId = anchor?.siteAnchorId;
  const tab = await chrome.tabs.get(anchor?.tabId).catch(() => null);
  if (!tab?.url) {
    anchorVerifications.delete(siteAnchorId);
    return false;
  }
  const kept = anchorVerifications.get(siteAnchorId);
  if (kept && kept.url !== tab.url) anchorVerifications.delete(siteAnchorId);
  else if (!fresh && kept) {
    if (kept.probe) return await kept.probe;
    if (kept.matchedAt + ANCHOR_VERIFICATION_TTL_MS > Date.now()) return true;
  }
  const probe = probeSiteAnchor(anchor, tab).catch(() => false);
  const entry = { tabId: tab.id, url: tab.url, probe, matchedAt: 0 };
  anchorVerifications.set(siteAnchorId, entry);
  const matched = await probe;
  if (anchorVerifications.get(siteAnchorId) !== entry) return matched;
  if (matched) anchorVerifications.set(siteAnchorId, { tabId: tab.id, url: tab.url, probe: null, matchedAt: Date.now() });
  else anchorVerifications.delete(siteAnchorId);
  return matched;
}

function forgetSiteAnchorVerification(siteAnchorId) {
  anchorVerifications.delete(siteAnchorId);
}

function forgetTabSiteAnchorVerifications(tabId) {
  for (const [siteAnchorId, entry] of anchorVerifications) {
    if (entry.tabId === tabId) anchorVerifications.delete(siteAnchorId);
  }
}

async function publishBindings() {
  const bindings = await publicBindings();
  if (state.socket?.readyState === WebSocket.OPEN && state.generation) {
    state.socket.send(JSON.stringify({ schema: "morrow.bridge.bindings.v1", protocolVersion: PROTOCOL_VERSION, generation: state.generation, bindings, sentAt: Date.now() }));
  }
  void chrome.runtime.sendMessage({ type: "morrow_bridge_status_changed" }).catch(() => undefined);
}

// Chrome reports this when the tab closes and when it moves to another address. Either ends what a
// kept match proved, so it is dropped before the state below it is published.
async function canvasTabChanged(tabId) {
  forgetTabSiteAnchorVerifications(tabId);
  const { siteAnchors = [] } = await storage();
  if (storedAnchors(siteAnchors).some((anchor) => anchor.tabId === tabId)) await publishBindings();
}

async function publicSiteAnchors(stored) {
  return await Promise.all(storedAnchors(stored.siteAnchors).map(async (anchor) => ({
    siteAnchorId: anchor.siteAnchorId,
    provider: anchor.provider,
    origin: anchor.origin,
    ...(anchor.siteUrl ? { siteUrl: anchor.siteUrl } : {}),
    principalId: anchor.principalId,
    sessionGeneration: anchor.sessionGeneration,
    runtimeVerified: await siteAnchorMatches(anchor),
    lastSeenAt: anchor.lastSeenAt,
  })));
}

function settingsSender(sender) {
  return sender?.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("settings/settings.html");
}

function policyCode(error) {
  const code = String(error?.message || "");
  return /^(?:edit_policy|course_discovery|course_selection)_[a-z_]+$/.test(code)
    || code === "binding_limit_reached" || code === "connector_catalog_invalid"
    ? code
    : "edit_policy_failed";
}

// Every page request answers with a stable code as well as a message, so the popup, the setup guide
// and Plan and Edit settings name one state and one next action through
// connector/extension/src/bridge-problem-copy.js. A failure that carries no code of its own is
// named bridge_request_failed rather than given an invented one.
function messageCode(error) {
  const code = String(error?.message || "");
  return /^[a-z][a-z0-9_]{2,80}$/.test(code) ? code : "bridge_request_failed";
}

async function editPolicyStatus() {
  const api = await catalog();
  const stored = await storage();
  const published = new Map((await publicBindings()).map((binding) => [binding.sourceBindingId, binding]));
  const siteAnchors = await publicSiteAnchors(stored);
  const bindings = await Promise.all((stored.bindings || []).map(async (binding) => {
    const staleEditPermission = stalePermissionSummary(storedPolicies(stored.editPolicies)[binding.sourceBindingId], binding, api.catalogDigest, [...state.operations.values()]);
    const current = published.get(binding.sourceBindingId);
    return {
      sourceBindingId: binding.sourceBindingId,
      provider: binding.provider,
      origin: binding.origin,
      ...(binding.siteUrl ? { siteUrl: binding.siteUrl } : {}),
      ...(binding.courseId ? { courseId: binding.courseId } : {}),
      ...(binding.courseName ? { courseName: binding.courseName } : {}),
      principalId: binding.principalId,
      sessionGeneration: binding.sessionGeneration,
      runtimeVerified: current?.runtimeVerified === true,
      editPolicyRevision: current?.editPolicyRevision || 0,
      editOptionsAvailable: current?.editOptionsAvailable === true,
      ...(current?.editPermission ? { editPermission: current.editPermission } : {}),
      ...(staleEditPermission ? { staleEditPermission: editPermissionSummary(staleEditPermission) } : {}),
    };
  }));
  return { catalogDigest: api.catalogDigest, bindingLimit: BRIDGE_BINDING_LIMIT, editDurations: SETTINGS_EDIT_DURATIONS, siteAnchors, bindings };
}

function editPermissionSummary(permission) {
  return {
    schema: permission.schema,
    revision: permission.revision,
    scopeDigest: permission.scopeDigest,
    catalogDigest: permission.catalogDigest,
    sourceBindingId: permission.sourceBindingId,
    ...(permission.expiresAt === undefined ? {} : { expiresAt: permission.expiresAt }),
  };
}

async function saveEditPolicy(sourceBindingId, enabledCategories, expiresInMs) {
  if (typeof sourceBindingId !== "string" || !sourceBindingId || !Array.isArray(enabledCategories) || !enabledCategories.length) throw new Error("edit_policy_categories_invalid");
  if (!validEditDuration(expiresInMs)) throw new Error("edit_policy_expiration_invalid");
  const result = await queueStorageMutation(async () => {
    const api = await catalog();
    const stored = await storage();
    const binding = (stored.bindings || []).find((candidate) => candidate.sourceBindingId === sourceBindingId);
    if (!binding) throw new Error("edit_policy_binding_missing");
    const anchor = anchorForBinding(binding, stored.siteAnchors);
    if (!anchor || !await siteAnchorMatches(anchor, { fresh: true })) throw new Error("edit_policy_binding_stale");
    const policies = storedPolicies(stored.editPolicies);
    const revisions = storedPolicyRevisions(stored.editPolicyRevisions);
    const priorRevision = Math.max(Number.isSafeInteger(revisions[sourceBindingId]) ? revisions[sourceBindingId] : 0, Number.isSafeInteger(policies[sourceBindingId]?.revision) ? policies[sourceBindingId].revision : 0);
    const editPermission = await createEditPermission({ binding, catalogDigest: api.catalogDigest, revision: priorRevision + 1, enabledCategories, operations: [...state.operations.values()], expiresAt: Date.now() + expiresInMs });
    await chrome.storage.local.set({ editPolicies: { ...policies, [sourceBindingId]: editPermission }, editPolicyRevisions: { ...revisions, [sourceBindingId]: editPermission.revision } });
    return editPermission;
  });
  await publishBindings();
  return { editPermission: result };
}

async function revokeEditPolicy(sourceBindingId) {
  if (typeof sourceBindingId !== "string" || !sourceBindingId) throw new Error("edit_policy_binding_missing");
  const result = await queueStorageMutation(async () => {
    const stored = await storage();
    if (!(stored.bindings || []).some((candidate) => candidate.sourceBindingId === sourceBindingId)) throw new Error("edit_policy_binding_missing");
    const policies = storedPolicies(stored.editPolicies);
    const revisions = storedPolicyRevisions(stored.editPolicyRevisions);
    const priorRevision = Math.max(Number.isSafeInteger(revisions[sourceBindingId]) ? revisions[sourceBindingId] : 0, Number.isSafeInteger(policies[sourceBindingId]?.revision) ? policies[sourceBindingId].revision : 0);
    const nextPolicies = { ...policies };
    delete nextPolicies[sourceBindingId];
    await chrome.storage.local.set({ editPolicies: nextPolicies, editPolicyRevisions: { ...revisions, [sourceBindingId]: priorRevision + 1 } });
    return priorRevision + 1;
  });
  await publishBindings();
  return { revoked: true, revision: result };
}

function bridgePolicySet(command) {
  if (!command || command.protocolVersion !== PROTOCOL_VERSION || command.kind !== "edit_policy_set"
    || Object.keys(command).some((key) => !["schema", "protocolVersion", "requestId", "operationId", "kind", "editPolicySet", "generation", "createdAt", "expiresAt"].includes(key))) {
    throw new Error("edit_policy_set_invalid");
  }
  if (command.generation !== state.generation || !Number.isSafeInteger(command.expiresAt) || Date.now() > command.expiresAt) {
    throw new Error("edit_policy_set_stale");
  }
  const value = command.editPolicySet;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["mode", "selections"].includes(key))
    || !["edit", "plan"].includes(value.mode) || !Array.isArray(value.selections) || !value.selections.length || value.selections.length > EDIT_POLICY_SELECTION_LIMIT) {
    throw new Error("edit_policy_set_invalid");
  }
  const selections = value.selections.map((selection) => {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)
      || Object.keys(selection).some((key) => !["sourceBindingId", "expectedPolicyRevision", "enabledCategories"].includes(key))
      || typeof selection.sourceBindingId !== "string" || !/^[A-Za-z0-9_.:@-]{1,160}$/.test(selection.sourceBindingId)
      || !Number.isSafeInteger(selection.expectedPolicyRevision) || selection.expectedPolicyRevision < 0) {
      throw new Error("edit_policy_set_invalid");
    }
    if (value.mode === "plan") {
      if (selection.enabledCategories !== undefined) throw new Error("edit_policy_set_invalid");
      return { sourceBindingId: selection.sourceBindingId, expectedPolicyRevision: selection.expectedPolicyRevision };
    }
    if (!Array.isArray(selection.enabledCategories) || !selection.enabledCategories.length || selection.enabledCategories.length > EDIT_POLICY_SELECTION_LIMIT
      || selection.enabledCategories.some((category) => typeof category !== "string" || !/^[A-Za-z0-9_.:@-]{1,160}$/.test(category))
      || new Set(selection.enabledCategories).size !== selection.enabledCategories.length
      || selection.enabledCategories.some((category, index) => index > 0 && selection.enabledCategories[index - 1] >= category)) {
      throw new Error("edit_policy_set_invalid");
    }
    return { sourceBindingId: selection.sourceBindingId, expectedPolicyRevision: selection.expectedPolicyRevision, enabledCategories: selection.enabledCategories };
  });
  if (new Set(selections.map((selection) => selection.sourceBindingId)).size !== selections.length
    || selections.some((selection, index) => index > 0 && selections[index - 1].sourceBindingId >= selection.sourceBindingId)) {
    throw new Error("edit_policy_set_invalid");
  }
  return { mode: value.mode, selections };
}

function bridgePolicyOptionsGet(command) {
  if (!command || command.protocolVersion !== PROTOCOL_VERSION || command.kind !== "edit_policy_options_get"
    || Object.keys(command).some((key) => !["schema", "protocolVersion", "requestId", "operationId", "kind", "sourceBindingId", "generation", "createdAt", "expiresAt"].includes(key))) {
    throw new Error("edit_policy_options_invalid");
  }
  if (command.generation !== state.generation || !Number.isSafeInteger(command.expiresAt) || Date.now() > command.expiresAt) {
    throw new Error("edit_policy_options_stale");
  }
  if (typeof command.sourceBindingId !== "string" || !/^[A-Za-z0-9_.:@-]{1,160}$/.test(command.sourceBindingId)) {
    throw new Error("edit_policy_options_invalid");
  }
  return command.sourceBindingId;
}

async function editPolicyOptions(sourceBindingId) {
  const api = await catalog();
  const stored = await storage();
  const binding = (stored.bindings || []).find((candidate) => candidate.sourceBindingId === sourceBindingId);
  if (!binding) throw new Error("edit_policy_binding_missing");
  const anchor = anchorForBinding(binding, stored.siteAnchors);
  const permissions = storedPolicies(stored.editPolicies);
  const revisions = storedPolicyRevisions(stored.editPolicyRevisions);
  const editPermission = await editPermissionFor(binding, stored, api);
  const policyRevision = Math.max(
    Number.isSafeInteger(revisions[sourceBindingId]) ? revisions[sourceBindingId] : 0,
    Number.isSafeInteger(permissions[sourceBindingId]?.revision) ? permissions[sourceBindingId].revision : 0,
  );
  return {
    schema: "morrow.bridge.edit-options.v1",
    sourceBindingId,
    provider: binding.provider,
    catalogDigest: api.catalogDigest,
    policyRevision,
    runtimeVerified: Boolean(anchor && await siteAnchorMatches(anchor, { fresh: true })),
    options: categoriesForBinding(binding, [...state.operations.values()]),
    ...(editPermission ? { editPermission } : {}),
  };
}

async function applyBridgePolicySet(policySet) {
  const result = await queueStorageMutation(async () => {
    const api = await catalog();
    const stored = await storage();
    const policies = storedPolicies(stored.editPolicies);
    const revisions = storedPolicyRevisions(stored.editPolicyRevisions);
    const nextPolicies = { ...policies };
    const nextRevisions = { ...revisions };
    const entries = [];
    let changed = false;
    for (const selection of policySet.selections) {
      const binding = (stored.bindings || []).find((candidate) => candidate.sourceBindingId === selection.sourceBindingId);
      if (!binding) {
        entries.push({ sourceBindingId: selection.sourceBindingId, state: "unavailable", code: "edit_policy_binding_missing" });
        continue;
      }
      const priorRevision = Math.max(Number.isSafeInteger(revisions[selection.sourceBindingId]) ? revisions[selection.sourceBindingId] : 0, Number.isSafeInteger(policies[selection.sourceBindingId]?.revision) ? policies[selection.sourceBindingId].revision : 0);
      const permission = await editPermissionFor(binding, stored, api);
      if (priorRevision !== selection.expectedPolicyRevision) {
        entries.push({ sourceBindingId: selection.sourceBindingId, state: permission ? "edit" : "plan", revision: priorRevision, ...(permission ? { editPermission: permission } : {}), code: "edit_policy_revision_stale" });
        continue;
      }
      if (policySet.mode === "plan") {
        if (!Object.hasOwn(nextPolicies, selection.sourceBindingId)) {
          entries.push({ sourceBindingId: selection.sourceBindingId, state: "plan", revision: priorRevision, changed: false });
          continue;
        }
        delete nextPolicies[selection.sourceBindingId];
        nextRevisions[selection.sourceBindingId] = priorRevision + 1;
        entries.push({ sourceBindingId: selection.sourceBindingId, state: "plan", revision: priorRevision + 1, changed: true });
        changed = true;
        continue;
      }
      const anchor = anchorForBinding(binding, stored.siteAnchors);
      if (!anchor || !await siteAnchorMatches(anchor, { fresh: true })) {
        entries.push({ sourceBindingId: selection.sourceBindingId, state: permission ? "edit" : "plan", revision: priorRevision, ...(permission ? { editPermission: permission } : {}), code: "edit_policy_binding_stale" });
        continue;
      }
      try {
        const editPermission = await createEditPermission({
          binding,
          catalogDigest: api.catalogDigest,
          revision: priorRevision + 1,
          enabledCategories: selection.enabledCategories,
          operations: [...state.operations.values()],
          expiresAt: Date.now() + CONVERSATIONAL_EDIT_DURATION_MS,
        });
        nextPolicies[selection.sourceBindingId] = editPermission;
        nextRevisions[selection.sourceBindingId] = editPermission.revision;
        entries.push({ sourceBindingId: selection.sourceBindingId, state: "edit", revision: editPermission.revision, changed: true, editPermission });
        changed = true;
      } catch (error) {
        entries.push({ sourceBindingId: selection.sourceBindingId, state: permission ? "edit" : "plan", revision: priorRevision, ...(permission ? { editPermission: permission } : {}), code: policyCode(error) });
      }
    }
    if (changed) await chrome.storage.local.set({ editPolicies: nextPolicies, editPolicyRevisions: nextRevisions });
    return { schema: "morrow.bridge.edit-policy-set.v1", mode: policySet.mode, entries };
  });
  await publishBindings();
  return result;
}

function discoveryCourses(value, maximum = DISCOVERY_PAGE_LIMIT) {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("course_discovery_failed");
  const seen = new Set();
  const courses = value.map((course) => {
    const id = decimalId(course?.id);
    const name = typeof course?.name === "string" ? course.name.trim().slice(0, 300) : "";
    if (!id || !name || seen.has(id)) throw new Error("course_discovery_failed");
    seen.add(id);
    return { id, name };
  });
  return courses.sort((left, right) => Number(left.id) - Number(right.id));
}

function sameAnchorReceipt(receipt, anchor) {
  return receipt?.schema === "morrow.course-discovery.v1"
    && receipt.siteAnchorId === anchor.siteAnchorId
    && receipt.provider === anchor.provider
    && receipt.origin === anchor.origin
    && (receipt.siteUrl || "") === (anchor.siteUrl || "")
    && receipt.principalFingerprint === anchor.principalFingerprint
    && receipt.sessionGeneration === anchor.sessionGeneration
    && Number.isSafeInteger(receipt.pageNumber) && receipt.pageNumber >= 1
    && Number.isFinite(receipt.expiresAt) && Date.now() < receipt.expiresAt;
}

function continuation(value) {
  if (value?.kind === "canvas_page" && Number.isSafeInteger(value.value) && value.value > 1) return value;
  if (value?.kind === "moodle_offset" && Number.isSafeInteger(value.value) && value.value > 0 && value.value <= 10_000) return value;
  return null;
}

async function listAnchorCourses(anchor, next = null) {
  if (anchor.provider === "canvas") {
    try {
      if (next && next.kind !== "canvas_page") throw new Error("course_discovery_failed");
      await chrome.scripting.executeScript({ target: { tabId: anchor.tabId, frameIds: [0] }, files: ["src/canvas-content.js"] });
      const result = await chrome.tabs.sendMessage(anchor.tabId, { type: "morrow_canvas_list_courses", ...(next ? { page: next.value } : {}) }, { frameId: 0 });
      if (result?.ok !== true || result.profile?.origin !== anchor.origin || result.profile?.id !== anchor.principalId) throw new Error("course_discovery_failed");
      const complete = result.complete === true;
      const nextPage = Number.isSafeInteger(result.nextPage) && result.nextPage > (next?.value || 1) ? result.nextPage : null;
      if (complete !== (nextPage === null)) throw new Error("course_discovery_failed");
      return { courses: discoveryCourses(result.courses, DISCOVERY_PAGE_LIMIT), complete, next: nextPage === null ? null : { kind: "canvas_page", value: nextPage } };
    } catch {
      throw new Error("course_discovery_failed");
    }
  }
  if (anchor.provider === "moodle") {
    if (next && next.kind !== "moodle_offset") throw new Error("course_discovery_failed");
    const offset = next?.value || 0;
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: anchor.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleInPage,
      args: [JSON.stringify({ mode: "discover_courses", limit: DISCOVERY_PAGE_LIMIT, offset, expiresAt: Date.now() + 30_000 })],
    }).catch(() => []);
    const result = execution?.result;
    if (result?.ok !== true || result.sent !== true) throw new Error("course_discovery_failed");
    const data = result.data || {};
    const complete = data.complete === true;
    const nextOffset = Number.isSafeInteger(data.next_offset) && data.next_offset > offset ? data.next_offset : null;
    if (complete !== (nextOffset === null)) throw new Error("course_discovery_failed");
    return { courses: discoveryCourses(data.courses, DISCOVERY_PAGE_LIMIT), complete, next: nextOffset === null ? null : { kind: "moodle_offset", value: nextOffset } };
  }
  throw new Error("course_discovery_failed");
}

async function checkAnchorCourse(anchor, courseId) {
  if (anchor.provider === "canvas") {
    try {
      await chrome.scripting.executeScript({ target: { tabId: anchor.tabId, frameIds: [0] }, files: ["src/canvas-content.js"] });
      const result = await chrome.tabs.sendMessage(anchor.tabId, { type: "morrow_canvas_check_course", courseId }, { frameId: 0 });
      if (result?.ok !== true || result.profile?.origin !== anchor.origin || result.profile?.id !== anchor.principalId || result.course?.id !== courseId) throw new Error("course_selection_target_refused");
      return discoveryCourses([result.course], 1)[0];
    } catch (error) {
      if (error?.message === "course_selection_target_refused") throw error;
      throw new Error("course_selection_target_refused");
    }
  }
  if (anchor.provider === "moodle") {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: anchor.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleInPage,
      args: [JSON.stringify({ mode: "check_course", courseId, expiresAt: Date.now() + 30_000 })],
    }).catch(() => []);
    const result = execution?.result;
    if (result?.ok !== true || result.sent !== true || result.data?.id !== courseId) throw new Error("course_selection_target_refused");
    return discoveryCourses([result.data], 1)[0];
  }
  throw new Error("course_selection_target_refused");
}

async function startCourseDiscovery(siteAnchorId) {
  if (typeof siteAnchorId !== "string" || !siteAnchorId) throw new Error("course_discovery_anchor_missing");
  return await queueStorageMutation(async () => {
    const stored = await storage();
    const anchor = storedAnchors(stored.siteAnchors).find((candidate) => candidate.siteAnchorId === siteAnchorId);
    if (!anchor) throw new Error("course_discovery_anchor_missing");
    if (!await siteAnchorMatches(anchor, { fresh: true })) throw new Error("course_discovery_anchor_stale");
    const listed = await listAnchorCourses(anchor, anchor.provider === "canvas" ? { kind: "canvas_page", value: 1 } : null);
    if (!await siteAnchorMatches(anchor, { fresh: true })) throw new Error("course_discovery_anchor_stale");
    const createdAt = Date.now();
    const receipt = {
      schema: "morrow.course-discovery.v1",
      discoveryReceiptId: `discovery:${crypto.randomUUID()}`,
      siteAnchorId: anchor.siteAnchorId,
      provider: anchor.provider,
      origin: anchor.origin,
      ...(anchor.siteUrl ? { siteUrl: anchor.siteUrl } : {}),
      principalFingerprint: anchor.principalFingerprint,
      sessionGeneration: anchor.sessionGeneration,
      createdAt,
      expiresAt: createdAt + DISCOVERY_TTL_MS,
      snapshotDigest: await sha256(JSON.stringify(listed.courses)),
      courses: listed.courses,
      pageNumber: 1,
      complete: listed.complete,
      next: listed.next,
    };
    const saved = await discoveries();
    const next = Object.fromEntries(Object.entries(storedDiscoveries(saved.courseDiscoveries)).filter(([, prior]) => prior?.siteAnchorId !== anchor.siteAnchorId));
    next[receipt.discoveryReceiptId] = receipt;
    await discoveryArea().set({ courseDiscoveries: next });
    return publicDiscoveryReceipt(anchor, receipt);
  });
}

function publicDiscoveryReceipt(anchor, receipt) {
  return {
    siteAnchorId: anchor.siteAnchorId,
    provider: anchor.provider,
    origin: anchor.origin,
    ...(anchor.siteUrl ? { siteUrl: anchor.siteUrl } : {}),
    principalId: anchor.principalId,
    sessionGeneration: anchor.sessionGeneration,
    discoveryReceiptId: receipt.discoveryReceiptId,
    expiresAt: receipt.expiresAt,
    courses: receipt.courses,
    pageNumber: receipt.pageNumber,
    complete: receipt.complete,
    courseCount: receipt.courses.length,
  };
}

async function continueCourseDiscovery(siteAnchorId, discoveryReceiptId) {
  if (typeof siteAnchorId !== "string" || !siteAnchorId || typeof discoveryReceiptId !== "string" || !discoveryReceiptId) throw new Error("course_discovery_receipt_missing");
  return await queueStorageMutation(async () => {
    const stored = await storage();
    const anchor = storedAnchors(stored.siteAnchors).find((candidate) => candidate.siteAnchorId === siteAnchorId);
    if (!anchor) throw new Error("course_discovery_anchor_missing");
    const saved = await discoveries();
    const receipt = storedDiscoveries(saved.courseDiscoveries)[discoveryReceiptId];
    if (!receipt) throw new Error("course_discovery_receipt_missing");
    if (!sameAnchorReceipt(receipt, anchor)) throw new Error("course_discovery_receipt_stale");
    if (receipt.complete === true) throw new Error("course_discovery_complete");
    const next = continuation(receipt.next);
    if (!next) throw new Error("course_discovery_failed");
    if (!await siteAnchorMatches(anchor, { fresh: true })) throw new Error("course_discovery_anchor_stale");
    const listed = await listAnchorCourses(anchor, next);
    if (!await siteAnchorMatches(anchor, { fresh: true })) throw new Error("course_discovery_anchor_stale");
    const updated = {
      ...receipt,
      courses: listed.courses,
      snapshotDigest: await sha256(JSON.stringify(listed.courses)),
      pageNumber: receipt.pageNumber + 1,
      complete: listed.complete,
      next: listed.next,
    };
    const nextDiscoveries = { ...storedDiscoveries(saved.courseDiscoveries), [discoveryReceiptId]: updated };
    await discoveryArea().set({ courseDiscoveries: nextDiscoveries });
    return publicDiscoveryReceipt(anchor, updated);
  });
}

async function saveCourseSelection(siteAnchorId, discoveryReceiptId, courseIds) {
  if (typeof siteAnchorId !== "string" || !siteAnchorId || typeof discoveryReceiptId !== "string" || !discoveryReceiptId
    || !Array.isArray(courseIds) || !courseIds.length || courseIds.length > DISCOVERY_PAGE_LIMIT) throw new Error("course_selection_invalid");
  const requestedIds = courseIds.map(decimalId);
  if (requestedIds.some((courseId) => !courseId) || new Set(requestedIds).size !== requestedIds.length) throw new Error("course_selection_invalid");
  const result = await queueStorageMutation(async () => {
    const stored = await storage();
    const anchor = storedAnchors(stored.siteAnchors).find((candidate) => candidate.siteAnchorId === siteAnchorId);
    if (!anchor) throw new Error("course_discovery_anchor_missing");
    const saved = await discoveries();
    const receipt = storedDiscoveries(saved.courseDiscoveries)[discoveryReceiptId];
    if (!receipt) throw new Error("course_discovery_receipt_missing");
    if (!sameAnchorReceipt(receipt, anchor)) throw new Error("course_discovery_receipt_stale");
    const offered = new Map(discoveryCourses(receipt.courses).map((course) => [course.id, course]));
    const ids = requestedIds;
    if (ids.some((courseId) => !offered.has(courseId))) throw new Error("course_selection_unavailable");
    if (!await siteAnchorMatches(anchor, { fresh: true })) throw new Error("course_discovery_anchor_stale");
    const checked = [];
    for (const courseId of ids) checked.push(await checkAnchorCourse(anchor, courseId));
    if (!await siteAnchorMatches(anchor, { fresh: true })) throw new Error("course_discovery_anchor_stale");
    const bindings = [...(stored.bindings || [])];
    const policies = { ...storedPolicies(stored.editPolicies) };
    const added = [];
    for (const course of checked) {
      const existing = bindings.find((binding) => binding.siteAnchorId === anchor.siteAnchorId && binding.courseId === course.id);
      if (existing) {
        existing.courseName = course.name;
        added.push(existing);
        continue;
      }
      if (bindings.length >= BRIDGE_BINDING_LIMIT) throw new Error("binding_limit_reached");
      const binding = {
        sourceBindingId: `${anchor.siteAnchorId}:c${course.id}`,
        siteAnchorId: anchor.siteAnchorId,
        provider: anchor.provider,
        origin: anchor.origin,
        ...(anchor.siteUrl ? { siteUrl: anchor.siteUrl } : {}),
        principalFingerprint: anchor.principalFingerprint,
        principalId: anchor.principalId,
        sessionGeneration: anchor.sessionGeneration,
        courseId: course.id,
        courseName: course.name,
        runtimeVerified: true,
        lastSeenAt: Date.now(),
      };
      bindings.push(binding);
      delete policies[binding.sourceBindingId];
      added.push(binding);
    }
    await chrome.storage.local.set({ bindings, editPolicies: policies });
    return { siteAnchorId: anchor.siteAnchorId, bindings: added.map(({ principalId: _principalId, siteAnchorId: _siteAnchorId, ...binding }) => binding) };
  });
  await publishBindings();
  return result;
}

async function connectBridge() {
  const stored = await storage();
  if (!stored.token || state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING) return;
  const api = await catalog();
  const socket = new WebSocket(bridgeUrl());
  state.socket = socket;
  socket.onopen = async () => socket.send(JSON.stringify({
    schema: "morrow.bridge.hello.v1",
    protocolVersion: PROTOCOL_VERSION,
    token: stored.token,
    extensionId: chrome.runtime.id,
    runtimeRevision: RUNTIME_REVISION,
    catalogDigest: api.catalogDigest,
    bindings: await publicBindings(),
    sentAt: Date.now(),
  }));
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    void handleBridgeMessage(message).then(() => {
      if (message?.schema === "morrow.bridge.ready.v1" && state.socket === socket) {
        void chrome.runtime.sendMessage({ type: "morrow_bridge_status_changed" }).catch(() => undefined);
      }
    });
  };
  socket.onclose = (event) => {
    if (state.socket !== socket) return;
    state.socket = null;
    state.generation = 0;
    state.accepted = null;
    void chrome.runtime.sendMessage({ type: "morrow_bridge_status_changed" }).catch(() => undefined);
    if (event.code === 4403) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
      void (async () => {
        const latest = await storage();
        if (latest.token !== stored.token) return;
        await chrome.alarms.clear("morrow-pairing");
        await queueStorageMutation(async () => {
          await chrome.storage.local.remove(["token", "bindings", "pairing", "siteAnchors", "editPolicies", "editPolicyRevisions", "firstCourseRead"]);
          await discoveryArea().remove("courseDiscoveries");
        });
      })();
      return;
    }
    scheduleReconnect();
  };
  socket.onerror = () => undefined;
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connectBridge();
  }, 2_000);
}

function problem(code, message, recoverable = false) {
  return { schema: "morrow.bridge.problem.v1", code, message, recoverable };
}

function errorMessage(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "Canvas returned an unreadable error.";
  }
}

function withoutPrivateAttachment(value) {
  if (Array.isArray(value)) return value.map(withoutPrivateAttachment);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["privateAttachment", "privateAttachments", "privateConversation", "bytes_base64", "upload_url", "upload_params", "download_url", "confirmation_url"].includes(key))
    .map(([key, entry]) => [key, withoutPrivateAttachment(entry)]));
}

function sendResult(command, ok, result, failure) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify({
    schema: "morrow.bridge.result.v1",
    protocolVersion: PROTOCOL_VERSION,
    requestId: command.requestId,
    operationId: command.operationId,
    generation: command.generation,
    ok,
    ...(ok ? { result } : { ...(result ? { result } : {}), problem: failure }),
    completedAt: Date.now(),
  }));
}

async function bindingFor(id, { fresh = false } = {}) {
  const { bindings = [], siteAnchors = [] } = await storage();
  const binding = id ? bindings.find((candidate) => candidate.sourceBindingId === id)
    : bindings.length === 1 ? bindings[0] : null;
  if (!binding) return null;
  const anchor = anchorForBinding(binding, siteAnchors);
  if (!anchor) return { ...binding, runtimeVerified: false };
  return { ...materializeBinding(binding, anchor), runtimeVerified: binding.runtimeVerified && await siteAnchorMatches(anchor, { fresh }) };
}

/** The accepted receipts held in this browser session, oldest first, each with the moment its command was prepared. */
function storedUsedReceipts(value) {
  return Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" && entry
      ? [{ id: entry, at: 0 }]
      : typeof entry?.id === "string" && entry.id && Number.isSafeInteger(entry.at) ? [{ id: entry.id, at: entry.at }] : []))
    : [];
}

/**
 * Accepts one reviewed change exactly once, and answers with the reason when it will not.
 *
 * The record holds the newest USED_EFFECT_RECEIPT_LIMIT receipts. Dropping the oldest one on its
 * own would let that change through a second time, so every drop also raises a mark that never
 * falls: the moment the newest dropped command was prepared. A command prepared at or before that
 * mark is refused, because Morrow no longer holds the record that would prove it is new.
 */
async function reserveReceiptNow(command) {
  if (command.kind !== "invoke_write") return null;
  const receipt = command.outerGrant?.effectReceiptId;
  const preparedAt = Number.isSafeInteger(command.createdAt) ? command.createdAt : null;
  if (!receipt || preparedAt === null) {
    return problem("effect_receipt_refused", "The provider effect receipt is missing or was already used.", false);
  }
  const area = discoveryArea();
  const stored = await area.get(["usedEffectReceipts", "usedEffectReceiptFloorAt"]);
  const used = storedUsedReceipts(stored.usedEffectReceipts);
  const floorAt = Number.isSafeInteger(stored.usedEffectReceiptFloorAt) ? stored.usedEffectReceiptFloorAt : 0;
  if (used.some((entry) => entry.id === receipt)) {
    return problem("effect_receipt_refused", "The provider effect receipt is missing or was already used.", false);
  }
  if (preparedAt <= floorAt) {
    return problem("effect_receipt_refused", "Morrow no longer holds the record of the changes from when this one was prepared, so it did not send it.", false);
  }
  const kept = [...used, { id: receipt, at: preparedAt }];
  const dropped = kept.splice(0, Math.max(0, kept.length - USED_EFFECT_RECEIPT_LIMIT));
  await area.set({
    usedEffectReceipts: kept,
    usedEffectReceiptFloorAt: dropped.reduce((mark, entry) => Math.max(mark, entry.at), floorAt),
  });
  return null;
}

async function executeCanvas(binding, operation, args, expiresAt) {
  let sent = false;
  try {
    await chrome.scripting.executeScript({ target: { tabId: binding.tabId, frameIds: [0] }, files: ["src/canvas-content.js"] });
    sent = true;
    return await chrome.tabs.sendMessage(binding.tabId, {
      type: "morrow_canvas_execute",
      operation: { ...operation, morrowCourseTarget: canvasOperationAdmission(operation).courseTarget },
      arguments: args,
      principalId: binding.principalId,
      expiresAt,
      courseId: binding.courseId,
    }, { frameId: 0 });
  } catch (error) {
    return { ok: false, sent, outcomeUnknown: sent && !operation.readOnly, error: sent && !operation.readOnly ? "canvas_write_response_unknown" : String(error?.message || error) };
  }
}

function sameCanvasConversationBinding(left, right) {
  return right?.runtimeVerified === true
    && left?.origin === right.origin
    && left?.courseId === right.courseId
    && left?.principalId === right.principalId
    && left?.principalFingerprint === right.principalFingerprint
    && left?.sessionGeneration === right.sessionGeneration;
}

/**
 * The only route-less Canvas write admitted by this worker. The payload is
 * private, has already been matched to one official Inbox operation, and is
 * executed in Canvas's MAIN world so it can re-check membership and thread
 * context immediately before its one POST.
 */
async function executeCanvasConversation(binding, operation, privateConversation, expiresAt) {
  const payload = normalizeCanvasConversationPrivatePayload(privateConversation);
  if (!payload || !canvasConversationOperationMatches(operation, payload)) {
    return { ok: false, sent: false, error: "canvas_conversation_private_payload_refused" };
  }
  let result;
  try {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId: binding.tabId, frameIds: [0] },
      world: "MAIN",
      func: executeCanvasConversationInPage,
      args: [{
        binding: {
          origin: binding.origin,
          courseId: binding.courseId,
          principalId: binding.principalId,
          sessionGeneration: binding.sessionGeneration,
        },
        payload,
        expiresAt,
      }],
    });
    result = execution?.result || { ok: false, sent: true, outcomeUnknown: true, error: "canvas_conversation_result_missing" };
  } catch {
    return { ok: false, sent: true, outcomeUnknown: true, error: "canvas_conversation_execution_interrupted" };
  }
  // This reading decides whether the message that was just sent can be trusted, so it probes the
  // course site again rather than reading a match kept for the request before it.
  const current = await bindingFor(binding.sourceBindingId, { fresh: true }).catch(() => null);
  if (!sameCanvasConversationBinding(binding, current)) {
    return result?.sent === true
      ? { ok: false, sent: true, outcomeUnknown: true, error: "canvas_conversation_binding_changed" }
      : { ok: false, sent: false, error: "canvas_conversation_binding_changed" };
  }
  return result;
}

async function executeItemBank(binding, operation, args) {
  try {
    // Only the Item Banks frame holds the credential this executor needs, so
    // the probe never reaches any other frame and never carries the item
    // payload. Both would hand a third-party frame on the same Canvas page the
    // question body, the principal, and the course before any guard ran.
    const frames = await chrome.webNavigation.getAllFrames({ tabId: binding.tabId }).catch(() => []);
    const candidates = itemBankFrameIds(frames);
    if (candidates.length === 0) return { ok: false, sent: false, error: "item_bank_context_not_established" };
    const rows = await chrome.scripting.executeScript({
      target: { tabId: binding.tabId, frameIds: candidates },
      world: "MAIN",
      func: executeItemBankInPage,
      args: [{ operation, principalId: binding.principalId, canvasOrigin: binding.origin, courseId: binding.courseId, contextOnly: true }],
    });
    const matches = rows.filter((row) => row.result?.matched === true);
    if (matches.length !== 1) return { ok: false, sent: false, error: matches.length ? "item_bank_context_ambiguous" : "item_bank_context_not_established" };
    try {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: binding.tabId, frameIds: [matches[0].frameId] },
        world: "MAIN",
        func: executeItemBankInPage,
        args: [{ operation, arguments: args, principalId: binding.principalId, canvasOrigin: binding.origin, courseId: binding.courseId }],
      });
      return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "item_bank_result_missing" };
    } catch {
      return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "item_bank_execution_interrupted" };
    }
  } catch (error) {
    return { ok: false, sent: false, error: String(error?.message || error) };
  }
}

async function executeOperation(binding, operation, args, expiresAt, privateAttachment, privateConversation, privateAttachments) {
  if (operation.provider === "canvas" && operation.key === CANVAS_CLASSIC_QUIZ_SUBMISSION_SUMMARY_OPERATION_KEY) {
    if (operation.toolName !== "canvas_get_classic_quiz_submission_summary" || !operation.readOnly
      || privateAttachment !== undefined || privateConversation !== undefined) {
      return { ok: false, sent: false, error: "canvas_classic_quiz_submission_summary_arguments_invalid" };
    }
    try {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeCanvasClassicQuizSubmissionSummaryInPage,
        args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
      });
      return execution?.result || { ok: false, sent: false, error: "canvas_classic_quiz_submission_summary_result_missing" };
    } catch {
      return { ok: false, sent: false, error: "canvas_classic_quiz_submission_summary_execution_interrupted" };
    }
  }
  if (operation.provider === "canvas" && CANVAS_COURSE_SUMMARY_OPERATIONS.has(operation.key)) {
    const prefix = operation.key === "canvas.api.v1.course.assignment.submissions.aggregate.read.v1"
      ? "canvas_assignment_submission_summary"
      : operation.key === "canvas.api.v1.course.gradebook.aggregate.read.v1"
        ? "canvas_course_gradebook_summary"
        : "canvas_course_activity_summary";
    if (operation.toolName !== CANVAS_COURSE_SUMMARY_OPERATIONS.get(operation.key) || !operation.readOnly
      || privateAttachment !== undefined || privateConversation !== undefined) {
      return { ok: false, sent: false, error: `${prefix}_arguments_invalid` };
    }
    try {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeCanvasCourseSummaryInPage,
        args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
      });
      return execution?.result || { ok: false, sent: false, error: `${prefix}_result_missing` };
    } catch {
      return { ok: false, sent: false, error: `${prefix}_execution_interrupted` };
    }
  }
  if (operation.provider === "canvas" && operation.key === CANVAS_FILE_SIGNALS_OPERATION_KEY) {
    if (privateAttachment !== undefined || privateConversation !== undefined) {
      return { ok: false, sent: false, error: "canvas_file_signals_arguments_invalid" };
    }
    return await executeCanvasCourseFileSignals(binding, operation, args, expiresAt);
  }
  if (operation.provider === "moodle") {
    const courseReportRead = MOODLE_COURSE_REPORT_READ_OPERATIONS.get(operation.key);
    if (courseReportRead) {
      if (operation.toolName !== courseReportRead.toolName || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: `${courseReportRead.prefix}_arguments_invalid` };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleCourseReportReadInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: `${courseReportRead.prefix}_result_missing` };
      } catch {
        return { ok: false, sent: false, error: `${courseReportRead.prefix}_execution_interrupted` };
      }
    }
    const siteAdministrationRead = MOODLE_SITE_ADMINISTRATION_READ_OPERATIONS.get(operation.key);
    if (siteAdministrationRead) {
      if (operation.toolName !== siteAdministrationRead.toolName || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: `${siteAdministrationRead.prefix}_arguments_invalid` };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleSiteInventoryReadInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: `${siteAdministrationRead.prefix}_result_missing` };
      } catch {
        return { ok: false, sent: false, error: `${siteAdministrationRead.prefix}_execution_interrupted` };
      }
    }
    const activityContentRead = MOODLE_ACTIVITY_CONTENT_READ_OPERATIONS.get(operation.key);
    if (activityContentRead) {
      if (operation.toolName !== activityContentRead.toolName || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: `${activityContentRead.prefix}_arguments_invalid` };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleActivityContentReadInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: `${activityContentRead.prefix}_result_missing` };
      } catch {
        return { ok: false, sent: false, error: `${activityContentRead.prefix}_execution_interrupted` };
      }
    }
    const activityContentWrite = MOODLE_ACTIVITY_CONTENT_WRITE_OPERATIONS.get(operation.key);
    if (activityContentWrite) {
      if (operation.toolName !== activityContentWrite.toolName || operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: `${activityContentWrite.prefix}_arguments_invalid` };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleActivityContentInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: true, outcomeUnknown: true, error: `${activityContentWrite.prefix}_result_missing` };
      } catch {
        return { ok: false, sent: true, outcomeUnknown: true, error: `${activityContentWrite.prefix}_execution_interrupted` };
      }
    }
    if (operation.key === MOODLE_QUIZ_ATTEMPT_SUMMARY_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_quiz_attempt_summary" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_quiz_attempt_summary_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleQuizAttemptSummaryInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_quiz_attempt_summary_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_quiz_attempt_summary_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_QUIZ_ATTEMPT_DETAIL_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_quiz_attempt" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_quiz_attempt_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleQuizAttemptInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_quiz_attempt_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_quiz_attempt_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_QUIZ_MANUAL_GRADING_QUEUE_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_quiz_manual_grading_queue" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_quiz_manual_grading_queue_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleQuizManualGradingQueueInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_quiz_manual_grading_queue_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_quiz_manual_grading_queue_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_QUIZ_REGRADE_REPORT_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_quiz_regrade_report" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_quiz_regrade_report_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleQuizRegradeReportInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_quiz_regrade_report_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_quiz_regrade_report_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_FORUM_ACTIVITY_SUMMARY_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_forum_activity_summary" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_forum_activity_summary_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleForumActivitySummaryInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_forum_activity_summary_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_forum_activity_summary_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_QUESTION_BANK_IMPACT_SCOPE_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_question_bank_impact_scope" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_question_bank_impact_scope_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleQuestionBankImpactScopeInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_question_bank_impact_scope_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_question_bank_impact_scope_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_LESSON_PAGE_LIST_OPERATION_KEY) {
      if (operation.toolName !== "moodle_list_lesson_pages" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_lesson_pages_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleLessonPageListInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_lesson_pages_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_lesson_pages_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_LESSON_PAGE_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_lesson_page" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_lesson_page_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleLessonPageInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_lesson_page_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_lesson_page_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_SCORM_ATTEMPT_SUMMARY_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_scorm_attempt_summary" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_scorm_attempt_summary_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleScormAttemptSummaryInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_scorm_attempt_summary_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_scorm_attempt_summary_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_SCORM_LEARNER_REPORT_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_scorm_learner_report" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_scorm_learner_report_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleScormLearnerReportInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_scorm_learner_report_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_scorm_learner_report_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_GRADE_REPORT_SUMMARY_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_grade_report_summary" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_grade_report_summary_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleGradeReportSummaryInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_grade_report_summary_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_grade_report_summary_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_LEARNER_GRADE_REPORT_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_learner_grade_report" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_learner_grade_report_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleLearnerGradeReportInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_learner_grade_report_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_learner_grade_report_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_ASSIGNMENT_SUBMISSION_SUMMARY_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_assignment_submission_summary" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_assignment_submission_summary_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleAssignmentSubmissionSummaryInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_assignment_submission_summary_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_assignment_submission_summary_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_ASSIGNMENT_SUBMISSION_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_assignment_submission" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_assignment_submission_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleAssignmentSubmissionInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_assignment_submission_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_assignment_submission_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_ASSIGNMENT_FEEDBACK_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_assignment_feedback" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_assignment_feedback_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleAssignmentFeedbackInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_assignment_feedback_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_assignment_feedback_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_GROUP_MAP_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_course_groups" || !operation.readOnly || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_groups_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleCourseGroupsInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_groups_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_groups_execution_interrupted" };
      }
    }
    if (MOODLE_GROUPS_LIFECYCLE_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_groups_attachment_refused" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleGroupsLifecycleInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_groups_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_groups_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_COURSE_PARTICIPANTS_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_course_participants" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_course_participants_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleCourseParticipantsInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_course_participants_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_course_participants_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_ENROLMENT_METHODS_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_enrolment_methods" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_enrolment_methods_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleEnrolmentMethodsInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_enrolment_methods_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_enrolment_methods_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_PARTICIPANT_ENROLMENT_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_participant_enrolment" || !operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_participant_enrolment_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleParticipantEnrolmentInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_participant_enrolment_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_participant_enrolment_execution_interrupted" };
      }
    }
    if (MOODLE_ENROLMENT_WRITE_OPERATIONS.has(operation.key)) {
      if (operation.toolName !== MOODLE_ENROLMENT_WRITE_OPERATIONS.get(operation.key) || operation.readOnly
        || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_enrolment_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleEnrolmentInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        // A missing result after an enrolment or role change is an unknown
        // outcome, never a refusal, because the change may have been sent.
        return execution?.result || { ok: false, sent: true, outcomeUnknown: true, error: "moodle_enrolment_result_missing" };
      } catch {
        return { ok: false, sent: true, outcomeUnknown: true, error: "moodle_enrolment_execution_interrupted" };
      }
    }
    if (operation.key === MOODLE_FORUM_EXPORT_OPERATION_KEY) {
      if (operation.toolName !== "moodle_get_forum_posts" || !operation.readOnly || privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_forum_export_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleForumReadInPage,
          args: [JSON.stringify({ operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: false, error: "moodle_forum_export_result_missing" };
      } catch {
        return { ok: false, sent: false, error: "moodle_forum_export_execution_interrupted" };
      }
    }
    if (MOODLE_SCORM_WRITE_OPERATIONS.has(operation.key)) {
      const expectsAttachment = operation.key === "moodle.form.course.modedit.scorm.package.replace.write.v1";
      if (operation.toolName !== MOODLE_SCORM_WRITE_OPERATIONS.get(operation.key) || operation.readOnly
        || privateConversation !== undefined || (privateAttachment !== undefined) !== expectsAttachment) {
        return { ok: false, sent: false, error: "moodle_scorm_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleScormInPage,
          // Chrome drops null object fields from scripting arguments unless they are serialized.
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, ...(privateAttachment ? { privateAttachment } : {}), binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: true, outcomeUnknown: true, error: "moodle_scorm_result_missing" };
      } catch {
        return { ok: false, sent: true, outcomeUnknown: true, error: "moodle_scorm_execution_interrupted" };
      }
    }
    if (MOODLE_H5P_OPERATION_KEYS.has(operation.key)) {
      const expectsAttachment = operation.key === "moodle.form.course.modedit.h5pactivity.create.write.v1";
      if (privateConversation !== undefined || (privateAttachment !== undefined) !== expectsAttachment) {
        return { ok: false, sent: false, error: "moodle_h5pactivity_arguments_invalid" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleH5pInPage,
          // Chrome drops null object fields from scripting arguments unless they are serialized.
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, ...(privateAttachment ? { privateAttachment } : {}), binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_h5pactivity_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_h5pactivity_execution_interrupted" };
      }
    }
    if (MOODLE_FORUM_POST_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_forum_post_attachment_refused" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleForumPostInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_forum_post_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_forum_post_execution_interrupted" };
      }
    }
    if (MOODLE_GLOSSARY_WIKI_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) {
        return { ok: false, sent: false, error: "moodle_glossary_wiki_attachment_refused" };
      }
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleGlossaryWikiInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_glossary_wiki_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_glossary_wiki_execution_interrupted" };
      }
    }
    if (MOODLE_LTI_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_lti_arguments_invalid" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleLtiInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_lti_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_lti_execution_interrupted" };
      }
    }
    if (MOODLE_BIGBLUEBUTTON_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_bigbluebuttonbn_arguments_invalid" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleBigBlueButtonInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_bigbluebuttonbn_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_bigbluebuttonbn_execution_interrupted" };
      }
    }
    if (MOODLE_QBANK_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_qbank_arguments_invalid" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleQbankInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_qbank_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_qbank_execution_interrupted" };
      }
    }
    if (MOODLE_QUIZ_STRUCTURE_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_quiz_structure_arguments_invalid" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleQuizStructureInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_quiz_structure_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_quiz_structure_execution_interrupted" };
      }
    }
    if (MOODLE_ACTIVITY_LIFECYCLE_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_activity_lifecycle_arguments_invalid" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleActivityLifecycleInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: true, outcomeUnknown: true, error: "moodle_activity_lifecycle_result_missing" };
      } catch {
        return { ok: false, sent: true, outcomeUnknown: true, error: "moodle_activity_lifecycle_execution_interrupted" };
      }
    }
    if (MOODLE_SECTION_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_section_arguments_invalid" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleSectionInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: true, outcomeUnknown: true, error: "moodle_section_result_missing" };
      } catch {
        return { ok: false, sent: true, outcomeUnknown: true, error: "moodle_section_execution_interrupted" };
      }
    }
    if (MOODLE_CALENDAR_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_calendar_attachment_refused" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleCalendarInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_calendar_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_calendar_execution_interrupted" };
      }
    }
    if (MOODLE_SUBSECTION_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_subsection_arguments_invalid" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleSubsectionInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_subsection_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_subsection_execution_interrupted" };
      }
    }
    if (MOODLE_WORKSHOP_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_workshop_attachment_refused" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleWorkshopInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_workshop_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_workshop_execution_interrupted" };
      }
    }
    if (MOODLE_LESSON_PAGE_WRITE_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_lesson_page_write_arguments_invalid" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleLessonPageWriteInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: true, outcomeUnknown: true, error: "moodle_lesson_page_write_result_missing" };
      } catch {
        return { ok: false, sent: true, outcomeUnknown: true, error: "moodle_lesson_page_write_execution_interrupted" };
      }
    }
    if (MOODLE_QBANK_QUESTION_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_qbank_question_arguments_invalid" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleQbankQuestionInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_qbank_question_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_qbank_question_execution_interrupted" };
      }
    }
    if (MOODLE_COURSE_SETTINGS_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_course_settings_arguments_invalid" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleCourseSettingsInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_course_settings_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_course_settings_execution_interrupted" };
      }
    }
    if (MOODLE_BACKUP_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_backup_arguments_invalid" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleBackupInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_backup_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_backup_execution_interrupted" };
      }
    }
    if (MOODLE_COMPLETION_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_completion_arguments_invalid" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleCompletionInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_completion_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_completion_execution_interrupted" };
      }
    }
    if (MOODLE_RESTRICTIONS_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined || privateConversation !== undefined) return { ok: false, sent: false, error: "moodle_restrictions_arguments_invalid" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleRestrictionsInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_restrictions_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_restrictions_execution_interrupted" };
      }
    }
    if (MOODLE_GRADEBOOK_OPERATION_KEYS.has(operation.key)) {
      if (privateAttachment !== undefined) return { ok: false, sent: false, error: "moodle_gradebook_attachment_refused" };
      try {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleGradebookInPage,
          args: [JSON.stringify({ mode: "execute", operation, arguments: args, binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
        });
        return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_gradebook_result_missing" };
      } catch {
        return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_gradebook_execution_interrupted" };
      }
    }
    if (operation.toolName === "moodle_get_course_participant_roster") {
      if (operation.key !== "moodle.native.participants_table.privacy_roster.v1" || !operation.readOnly
        || privateAttachment !== undefined || Object.keys(args).some((field) => field !== "course_id")
        || String(args.course_id) !== binding.courseId) {
        return { ok: false, sent: false, error: "moodle_roster_arguments_invalid" };
      }
      try {
        const api = await catalog();
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: collectMoodleCourseParticipantRoster,
          args: [JSON.stringify({
            courseId: String(args.course_id),
            binding: {
              sourceBindingId: binding.sourceBindingId, courseId: binding.courseId,
              origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId,
              principalFingerprint: binding.principalFingerprint, sessionGeneration: binding.sessionGeneration,
              catalogDigest: api.catalogDigest,
            },
            expiresAt: Math.min(expiresAt || Date.now() + 59_000, Date.now() + 59_000),
          })],
        });
        const roster = execution?.result;
        if (!roster || roster.schema !== "morrow.moodle-course-roster.v1" || typeof roster.complete !== "boolean"
          || !Array.isArray(roster.identities) || roster.sourceBindingId !== binding.sourceBindingId
          || roster.courseId !== binding.courseId || roster.origin !== binding.origin || roster.siteUrl !== binding.siteUrl
          || roster.principalFingerprint !== binding.principalFingerprint || roster.sessionGeneration !== binding.sessionGeneration
          || roster.catalogDigest !== api.catalogDigest) {
          return { ok: false, sent: false, error: "moodle_roster_result_invalid" };
        }
        return { schema: "morrow.moodle-browser-result.v1", ok: true, sent: true, status: 200,
          data: roster, truncated: !roster.complete, snapshot_digest: await sha256(JSON.stringify(roster)) };
      } catch {
        return { ok: false, sent: false, error: "moodle_roster_execution_interrupted" };
      }
    }
    try {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeMoodleInPage,
        // Chrome drops null object fields from scripting arguments unless they are serialized.
        args: [JSON.stringify({ mode: "execute", operation, arguments: args, ...(privateAttachment ? { privateAttachment } : {}), ...(privateAttachments ? { privateAttachments } : {}), binding: { origin: binding.origin, siteUrl: binding.siteUrl, principalId: binding.principalId, courseId: binding.courseId }, expiresAt })],
      });
      return execution?.result || { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_result_missing" };
    } catch {
      return { ok: false, sent: !operation.readOnly, outcomeUnknown: !operation.readOnly, error: "moodle_execution_interrupted" };
    }
  }
  if (privateCanvasCourseFileOperation(operation)) {
    if (!privateAttachment) return { ok: false, sent: false, error: "canvas_private_attachment_required" };
    return await executeCanvasCourseFileTransfer(binding, args, expiresAt, privateAttachment);
  }
  if (operation.service === "course_file_content") {
    return await executeCanvasCourseFileText(binding, operation, args, expiresAt);
  }
  if (privateConversation !== undefined) {
    return await executeCanvasConversation(binding, operation, privateConversation, expiresAt);
  }
  return operation.service === "item_bank"
    ? await executeItemBank(binding, operation, args)
    : await executeCanvas(binding, operation, args, expiresAt);
}

function privateCanvasUploadPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["course_id", "folder_id", "upload_url", "upload_params"].includes(key))
    || !decimalId(value.course_id) || !decimalId(value.folder_id)
    || typeof value.upload_url !== "string" || value.upload_url.length < 1 || value.upload_url.length > 8192
    || !value.upload_params || typeof value.upload_params !== "object" || Array.isArray(value.upload_params)) return null;
  let uploadUrl;
  try { uploadUrl = new URL(value.upload_url); } catch { return null; }
  if (uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password || uploadUrl.hash) return null;
  const entries = Object.entries(value.upload_params);
  if (!entries.length || entries.length > 64 || entries.some(([key, entry]) => (
    !/^[A-Za-z0-9_.-]{1,128}$/.test(key) || key === "file" || typeof entry !== "string" || entry.length > 8192
  ))) return null;
  return { uploadUrl, entries };
}

function privateCanvasConfirmationUrl(value, canvasOrigin) {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192) return null;
  let url;
  try { url = new URL(value, canvasOrigin); } catch { return null; }
  return url.protocol === "https:" && url.origin === canvasOrigin && !url.username && !url.password && !url.hash ? url : null;
}

/**
 * A Chrome match pattern carries the whole path and query, so the exact upload
 * URL is a valid filter and the observer is offered no other request. If Chrome
 * refuses that pattern, the observer falls back to the same host and path with a
 * trailing wildcard. It never widens to another host.
 */
function canvasUploadObserverPatterns(uploadUrl) {
  const prefix = `${uploadUrl.origin}${uploadUrl.pathname}*`;
  return uploadUrl.href === prefix ? [uploadUrl.href] : [uploadUrl.href, prefix];
}

function observeCanvasUploadConfirmation(uploadUrl, canvasOrigin, signal) {
  const expectedUrl = uploadUrl.href;
  if (canvasUploadObservers.has(expectedUrl)) return null;
  let resolve;
  let settled = false;
  let requestId = "";
  const finish = (value) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", abort);
    chrome.webRequest.onBeforeRequest.removeListener(beforeRequest);
    chrome.webRequest.onHeadersReceived.removeListener(listener);
    if (canvasUploadObservers.get(expectedUrl) === observer) canvasUploadObservers.delete(expectedUrl);
    resolve(value);
  };
  const beforeRequest = (details) => {
    if (details.url !== expectedUrl || details.method !== "POST") return;
    if (requestId && requestId !== details.requestId) {
      finish({ error: "canvas_file_upload_request_ambiguous" });
      return;
    }
    requestId = details.requestId;
  };
  const listener = (details) => {
    if (details.url !== expectedUrl || details.method !== "POST" || !requestId || details.requestId !== requestId) return;
    const location = (details.responseHeaders || []).find((header) => String(header.name).toLowerCase() === "location")?.value;
    finish({
      status: Number.isInteger(details.statusCode) ? details.statusCode : undefined,
      confirmation: privateCanvasConfirmationUrl(location, canvasOrigin),
    });
  };
  const abort = () => finish({ error: "canvas_file_transfer_timeout" });
  const result = new Promise((done) => { resolve = done; });
  const observer = { result, close: () => finish({ error: "canvas_file_upload_observer_closed" }) };
  const registered = canvasUploadObserverPatterns(uploadUrl).some((pattern) => {
    try {
      chrome.webRequest.onBeforeRequest.addListener(beforeRequest, { urls: [pattern] });
      chrome.webRequest.onHeadersReceived.addListener(listener, { urls: [pattern] }, ["responseHeaders"]);
      return true;
    } catch {
      chrome.webRequest.onBeforeRequest.removeListener(beforeRequest);
      chrome.webRequest.onHeadersReceived.removeListener(listener);
      return false;
    }
  });
  if (!registered) return null;
  signal.addEventListener("abort", abort, { once: true });
  canvasUploadObservers.set(expectedUrl, observer);
  return observer;
}

async function executeCanvasCourseFileTransfer(binding, args, expiresAt, privateAttachment) {
  if (!await courseFileStorageAccessEnabled()) return { ok: false, sent: false, error: "canvas_file_storage_access_required" };
  const deadline = Math.min(
    Number.isSafeInteger(expiresAt) && expiresAt > Date.now() ? expiresAt : Date.now() + COURSE_FILE_READ_TIMEOUT_MS,
    Date.now() + COURSE_FILE_READ_TIMEOUT_MS,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  let uploadDispatched = false;
  let uploadStatus;
  let uploadObserver;
  try {
    const execute = async (input) => {
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: binding.tabId, frameIds: [0] }, world: "MAIN", func: executeCanvasCourseFileTransferInPage,
        args: [input],
      });
      return execution?.result || null;
    };
    const transferInput = {
      binding: { origin: binding.origin, courseId: binding.courseId, principalId: binding.principalId },
      folderId: String(args.folder_id),
      attachment: privateAttachment,
    };
    const prepared = await execute({ ...transferInput, mode: "initialize" });
    const plan = prepared?.ok === true && prepared?.sent === false && privateCanvasUploadPlan(prepared.data);
    if (!plan || String(prepared.data.course_id) !== binding.courseId || String(prepared.data.folder_id) !== String(args.folder_id)) {
      return { ok: false, sent: false, error: prepared?.error || "canvas_file_upload_init_invalid" };
    }
    const form = new FormData();
    for (const [key, value] of plan.entries) form.append(key, value);
    form.append("file", new Blob([Uint8Array.from(atob(privateAttachment.bytes_base64), (character) => character.charCodeAt(0))], {
      type: privateAttachment.content_type,
    }), privateAttachment.manifest.filename);
    uploadObserver = observeCanvasUploadConfirmation(plan.uploadUrl, binding.origin, controller.signal);
    if (!uploadObserver) return { ok: false, sent: false, error: "canvas_file_upload_observer_unavailable" };
    uploadDispatched = true;
    const upload = await fetch(plan.uploadUrl, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
      body: form,
    });
    const observed = await uploadObserver.result;
    uploadStatus = observed.status || upload.status;
    const confirmation = observed.confirmation;
    if (!confirmation || !((uploadStatus >= 300 && uploadStatus < 400) || uploadStatus === 201)) {
      return { ok: false, sent: true, outcomeUnknown: true, status: uploadStatus, error: "canvas_file_upload_confirmation_refused" };
    }
    const completed = await execute({
      ...transferInput,
      mode: "complete",
      confirmation_url: confirmation.href,
      upload_status: uploadStatus,
    });
    if (!completed?.ok || !completed?.data || typeof completed.data.download_url !== "string") {
      return { ok: false, sent: true, outcomeUnknown: true, status: uploadStatus, error: completed?.error || "canvas_file_completion_invalid" };
    }
    const downloadUrl = privateCanvasConfirmationUrl(completed.data.download_url, binding.origin);
    if (!downloadUrl || !decimalId(completed.data.file?.id) || String(completed.data.course_id) !== binding.courseId
      || String(completed.data.folder_id) !== String(args.folder_id) || completed.data.sha256 !== privateAttachment.manifest.sha256) {
      return { ok: false, sent: true, outcomeUnknown: true, status: uploadStatus, error: "canvas_file_readback_mismatch" };
    }
    const download = await fetch(downloadUrl, {
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!download.ok) return { ok: false, sent: true, outcomeUnknown: true, status: download.status, error: "canvas_file_download_http_" + download.status };
    let finalUrl;
    try { finalUrl = new URL(download.url); } catch { return { ok: false, sent: true, outcomeUnknown: true, status: download.status, error: "canvas_file_download_origin_refused" }; }
    if (finalUrl.protocol !== "https:") return { ok: false, sent: true, outcomeUnknown: true, status: download.status, error: "canvas_file_download_origin_refused" };
    const bytes = await boundedResponseBytes(download, MAX_PRIVATE_FILE_BYTES, controller.signal);
    if (bytes.byteLength !== privateAttachment.manifest.size_bytes || await sha256Bytes(bytes) !== privateAttachment.manifest.sha256) {
      return { ok: false, sent: true, outcomeUnknown: true, status: download.status, error: "canvas_file_download_digest_mismatch" };
    }
    return {
      schema: "morrow.canvas-course-file-transfer.v1", ok: true, sent: true, outcomeUnknown: false, status: uploadStatus,
      verification: { schema: "morrow.browser-verification.v1", status: "verified", targets: [
        { type: "canvas_course", id: binding.courseId },
        { type: "canvas_folder", id: String(args.folder_id) },
        { type: "canvas_file", id: String(completed.data.file.id) },
      ] },
      data: {
        course_id: Number(binding.courseId), folder_id: Number(args.folder_id),
        file: completed.data.file, sha256: privateAttachment.manifest.sha256,
      },
    };
  } catch (error) {
    return {
      ok: false,
      sent: uploadDispatched,
      outcomeUnknown: uploadDispatched,
      ...(Number.isInteger(uploadStatus) ? { status: uploadStatus } : {}),
      error: controller.signal.aborted ? "canvas_file_transfer_timeout" : String(error?.message || error),
    };
  } finally {
    uploadObserver?.close();
    clearTimeout(timeout);
  }
}

function supportedCanvasContentGuardOperation(operation, guard) {
  if (!guard || typeof guard !== "object" || Array.isArray(guard)) return false;
  return CANVAS_CONTENT_GUARD_OPERATIONS.some((candidate) => candidate.kind === guard.kind
    && candidate.toolName === operation.toolName && candidate.key === operation.key);
}

async function editScopeProblem(command, binding, operation) {
  if (command.kind !== "invoke_write") return null;
  const authorization = command.outerGrant?.authorization;
  if (!authorization || authorization.kind === "review") return null;
  if (authorization.kind !== "edit_scope") return problem("edit_policy_authorization_invalid", "The Edit permission evidence is invalid.", false);
  const api = await catalog();
  const stored = await storage();
  const permission = await editPermissionFor(binding, stored, api);
  if (!permission || authorization.policyDigest !== permission.scopeDigest || authorization.policyRevision !== permission.revision) {
    return problem("edit_policy_stale", "The selected Edit permission changed. Create a fresh plan or review this change.", true);
  }
  const canvasContentGuard = command.arguments?.morrow_canvas_content_guard;
  const pageGuard = command.arguments?.morrow_page_guard;
  const itemBankGuard = command.arguments?.morrow_item_bank_guard;
  if ([canvasContentGuard, pageGuard, itemBankGuard].filter(Boolean).length > 1) return problem("edit_policy_guard_ambiguous", "This change has conflicting Canvas content guards.", false);
  const canvasContentGuardKind = canvasContentGuard && typeof canvasContentGuard === "object" && !Array.isArray(canvasContentGuard) ? canvasContentGuard.kind : undefined;
  const pageGuardKind = pageGuard && typeof pageGuard === "object" && !Array.isArray(pageGuard) ? pageGuard.kind : undefined;
  const itemBankGuardKind = itemBankGuard && typeof itemBankGuard === "object" && !Array.isArray(itemBankGuard) ? itemBankGuard.kind : undefined;
  const rules = permission.rules.filter((entry) => entry.operationKey === operation.key && entry.toolName === operation.toolName
    && (canvasContentGuard
      ? (entry.canvasContentGuardKind || undefined) === canvasContentGuardKind
      : pageGuard
        ? (entry.pageGuardKind || undefined) === pageGuardKind
        : itemBankGuard
          ? (entry.itemBankGuardKind || undefined) === itemBankGuardKind
          : !entry.canvasContentGuardKind && !entry.pageGuardKind && !entry.itemBankGuardKind));
  if (rules.length !== 1) return problem("edit_policy_rule_refused", "This change is outside the selected Edit permission.", true);
  const rule = rules[0];
  if (rule.requiresCanvasContentGuard && (!canvasContentGuard || typeof canvasContentGuard !== "object" || Array.isArray(canvasContentGuard))) {
    return problem("edit_policy_canvas_content_guard_required", "This Canvas content repair needs its current content guard.", true);
  }
  if (rule.requiresCanvasContentGuard && !supportedCanvasContentGuardOperation(operation, canvasContentGuard)) {
    return problem("edit_policy_canvas_content_guard_refused", "This Canvas content repair does not match its exact guarded operation.", false);
  }
  if (rule.requiresPageGuard && (!pageGuard || typeof pageGuard !== "object" || Array.isArray(pageGuard))) {
    return problem("edit_policy_page_guard_required", "This Canvas Page change needs its current Page guard.", true);
  }
  if (rule.requiresItemBankGuard && !guardedItemBankUpdate(operation, command.arguments)) {
    return problem("edit_policy_item_bank_guard_required", "This Item Bank question repair needs its current question and its confirmed list of affected courses.", true);
  }
  const fields = changedFields(command.arguments);
  if (rule.allowedChangedFields.length > 0 && !fields.length) {
    return problem("edit_policy_fields_refused", "This change does not include a field selected for Edit access.", true);
  }
  if (fields.some((field) => !rule.allowedChangedFields.includes(field))) {
    return problem("edit_policy_fields_refused", "This change includes fields outside the selected Edit permission.", true);
  }
  return null;
}

/**
 * True for an operation that carries a Canvas API route. The Canvas browser
 * catalog holds Morrow's own in-page routes instead, and the admission model
 * reads a route path, so it does not describe them. Each of those routes names
 * its course in its own `course_id` argument.
 */
function canvasApiRouteOperation(operation) {
  return operation?.provider === "canvas" && typeof operation.path === "string" && operation.path.length > 0;
}

function operationCourseId(operation, args) {
  if (operation?.provider === "moodle") return decimalId(args?.course_id);
  if (!operation || operation.provider !== "canvas") return "";
  if (!canvasApiRouteOperation(operation)) return decimalId(args?.course_id);
  const target = canvasOperationAdmission(operation).courseTarget;
  const field = target.kind === "none" ? "" : target.argument || "";
  return field ? decimalId(args?.[field]) : "";
}

function courseScopeProblem(command, binding, operation, canvasConversation) {
  if (canvasConversation) return null;
  const target = operationCourseId(operation, command.arguments || {});
  if (operation.provider === "moodle") {
    if (operation.toolName === "moodle_list_my_courses") return null;
    if (!target || target !== binding.courseId) return problem("course_binding_mismatch", "This request does not match the selected course.", true);
    return null;
  }
  // One of Morrow's own in-page Canvas routes. It carries no Canvas API path, so
  // its selected course is the `course_id` it was called with and nothing else.
  if (!canvasApiRouteOperation(operation)) {
    return target && target === binding.courseId
      ? null
      : problem("course_binding_mismatch", "This request does not match the selected course.", true);
  }
  const admission = canvasOperationAdmission(operation);
  // The Item Bank routes name a bank, never a course, so the guarded repair proves the course
  // through the guard instead of through a path argument. The frame checks the same course again
  // before it sends anything.
  const itemBankGuard = command.kind === "invoke_write" ? guardedItemBankUpdate(operation, command.arguments) : null;
  if (itemBankGuard) {
    return itemBankGuard.course_id === binding.courseId
      ? null
      : problem("course_binding_mismatch", "This request does not match the selected course.", true);
  }
  if (command.kind === "invoke_write" && admission.write.state === "held") {
    return problem("course_scope_required", "This change needs one selected course target.", true);
  }
  if (target && target !== binding.courseId) return problem("course_binding_mismatch", "This request does not match the selected course.", true);
  // The route names one object, not a course. Only the object id can be checked here; the course
  // that owns the object is read in the bound tab immediately before the change is sent. A route
  // that creates the object names no object at all, so what is checked here is the input that says
  // which calendar the new one lands in.
  if (admission.courseTarget.kind === "semantic_course_object" && command.kind === "invoke_write") {
    const semanticTarget = admission.courseTarget.target;
    if (semanticTarget.createsObject) {
      const context = canvasSemanticContextInputState(semanticTarget, command.arguments || {}, binding.courseId);
      if (context === "selected_course") return null;
      return context === "multi_context"
        ? problem(CANVAS_MULTI_CONTEXT_REFUSAL, `Morrow changes one course, and this ${semanticTarget.object} names more than one.`, true)
        : problem("canvas_semantic_target_course_mismatch", "This change needs the selected course's own calendar.", true);
    }
    return decimalId(command.arguments?.[semanticTarget.objectParameter])
      ? null
      : problem("canvas_semantic_target_course_mismatch", `This change needs one exact Canvas ${semanticTarget.object}.`, true);
  }
  if (!target && command.kind === "invoke_write") return problem("course_scope_required", "This change needs one selected course target.", true);
  return null;
}

/**
 * The selected course is known, but its signed-in site tab is not the one this connection was made
 * from: it was closed, signed out, or moved. Nothing has been sent. The message names that exact
 * site and the one control that reconnects it, which is the state the Morrow Bridge popup and the
 * setup guide already show for the same course.
 */
function lostCourseSiteProblem(binding, operation) {
  const site = binding?.siteUrl || binding?.origin || "";
  if (!binding || binding.provider !== operation.provider || !site) {
    return problem("canvas_binding_required", "Select one current connection for this learning platform.", true);
  }
  const platform = binding.provider === "moodle" ? "Moodle" : "Canvas";
  const course = String(binding.courseName || "").trim().slice(0, 200);
  return problem("canvas_binding_required", [
    `Morrow sent nothing: the ${platform} site tab for ${course || "this selected course"} is not open and signed in.`,
    `Open ${site} in Chrome, sign in, then select Connect course site in Morrow Bridge.`,
  ].join(" ").slice(0, 900), true);
}

async function commandContext(command) {
  if (command.generation !== state.generation || Date.now() > command.expiresAt) {
    return { failure: problem("stale_bridge_command", "The bridge command is stale.", false) };
  }
  const operation = state.operations.get(command.toolName) || privateCanvasCourseFileCommand(command);
  if (!operation || operation.key !== command.operationKey || operation.readOnly !== (command.kind === "invoke_read")) {
    return { failure: problem("operation_catalog_mismatch", "The command does not match the connector catalog.", false) };
  }
  // One Item Bank write has an Edit path: the guarded image alternative-text repair, which carries
  // a fresh reading of the exact question and the acknowledged list of every course the bank
  // reaches. Every other Item Bank write, and this one without an accepted guard, stays held.
  if (operation.service === "item_bank" && !operation.readOnly && operation.nickname !== "create_bank"
    && !guardedItemBankUpdate(operation, command.arguments)) {
    return { failure: operation.nickname === "update_item"
      ? problem("item_bank_fan_out_and_guard_required", "Morrow changes one Item Bank question only through its focused image alternative-text repair, with the current question read again and every course the bank reaches confirmed first.", false)
      : problem("item_bank_dependency_review_required", "Changes to an existing Item Bank require a complete dependency and affected-course review. This release cannot yet establish that evidence.", false) };
  }
  // A change always probes the course site again here, so the reading immediately before a write is
  // never one kept for an earlier request.
  const binding = await bindingFor(command.sourceBindingId, { fresh: command.kind === "invoke_write" });
  if (!binding?.runtimeVerified || binding.provider !== operation.provider) return { failure: lostCourseSiteProblem(binding, operation) };
  const privateConversationPresent = Object.hasOwn(command, "privateConversation");
  const privateConversation = privateConversationPresent
    ? normalizeCanvasConversationPrivatePayload(command.privateConversation)
    : undefined;
  const canvasConversation = command.kind === "invoke_write"
    && command.privateAttachment === undefined
    && command.privateAttachments === undefined
    && privateConversation !== undefined
    && canvasConversationOperationMatches(operation, privateConversation);
  const courseFailure = courseScopeProblem(command, binding, operation, canvasConversation);
  if (courseFailure) return { failure: courseFailure };
  const policyFailure = await editScopeProblem(command, binding, operation);
  if (policyFailure) return { failure: policyFailure };
  const privateMoodleFile = privateMoodleStagedFileOperation(operation);
  const privateCanvasFile = privateCanvasCourseFileOperation(operation);
  if (!privateMoodleFile && !privateCanvasFile && (command.privateAttachment !== undefined || command.privateAttachments !== undefined)) {
    return { failure: problem("private_attachment_refused", "A private file attachment is only accepted for one exact reviewed course-file change.", false) };
  }
  if (privateConversationPresent && !canvasConversation) {
    return { failure: problem("canvas_conversation_private_payload_refused", "This Canvas Inbox change does not match its exact private conversation payload.", false) };
  }
  if (!privateMoodleFile && !privateCanvasFile) return { binding, operation, ...(canvasConversation ? { privateConversation } : {}) };
  if (command.kind !== "invoke_write" || (privateMoodleFile?.attachmentMode === "single" && (command.privateAttachment === undefined || command.privateAttachments !== undefined))
    || (privateMoodleFile?.attachmentMode === "multiple" && (command.privateAttachments === undefined || command.privateAttachment !== undefined))
    || (privateCanvasFile && command.privateAttachment === undefined)) {
    return { failure: privateCanvasFile
      ? problem("canvas_private_attachment_required", "This Canvas course-file change needs its staged private file attachment.", true)
      : problem("moodle_private_attachment_required", "This Moodle staged-file change needs its staged private file attachment.", true) };
  }
  const privateAttachment = privateCanvasFile
    ? await privateCanvasAttachment(command.privateAttachment)
    : privateMoodleFile?.attachmentMode === "single"
      ? await privateMoodleAttachment(command.privateAttachment)
      : undefined;
  const privateAttachments = privateMoodleFile?.attachmentMode === "multiple"
    ? await privateMoodleAttachments(command.privateAttachments)
    : undefined;
  if ((privateMoodleFile?.attachmentMode === "single" && !privateAttachment)
    || (privateMoodleFile?.attachmentMode === "multiple" && !privateAttachments)
    || (privateCanvasFile && !privateAttachment)) {
    return { failure: privateCanvasFile
      ? problem("canvas_private_attachment_invalid", "The staged private Canvas file attachment could not be verified.", false)
      : problem("moodle_private_attachment_invalid", "The staged private file attachment could not be verified.", false) };
  }
  const matches = privateCanvasFile
    ? privateCanvasAttachmentMatches(command.arguments, privateAttachment)
    : privateMoodleFile.attachmentMode === "multiple"
      ? privateMoodleAttachmentsMatch(command.arguments, privateAttachments, privateMoodleFile.argumentNames)
      : privateMoodleAttachmentMatches(command.arguments, privateAttachment, privateMoodleFile.argumentNames);
  if (!matches) {
    return { failure: privateCanvasFile
      ? problem("canvas_private_attachment_mismatch", "The staged private file does not match this exact Canvas course and folder.", false)
      : problem("moodle_private_attachment_mismatch", "The staged private file does not match this exact Moodle staged-file change.", false) };
  }
  return { binding, operation, ...(privateAttachment ? { privateAttachment } : {}), ...(privateAttachments ? { privateAttachments } : {}) };
}

async function executeNamedCanvasReadback(binding, plan) {
  if (plan.progressReadOperation) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const progress = await executeOperation(binding, plan.progressReadOperation, plan.progressArguments);
      const assessed = evaluateCanvasOperationProgress(plan, progress);
      if (assessed?.settled) break;
      if (!assessed || assessed.terminal || attempt === 5) return assessed?.verification
        || { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "canvas_operation_progress_unavailable" };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const readback = await executeOperation(binding, plan.readOperation, plan.arguments);
  return evaluateCanvasOperationReadback(plan, readback)
    || { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "canvas_operation_readback_unavailable" };
}

/**
 * A Canvas file record carries links that are their own way in to the bytes: each one holds a signed
 * verifier. Morrow keeps a verifier out of every result it hands back, so a change to a course file
 * answers with the saved record and without those links.
 */
const CANVAS_SIGNED_LINK_FIELDS = Object.freeze(["url", "preview_url", "thumbnail_url"]);

function withoutSignedLinkFields(value) {
  if (Array.isArray(value)) return value.map((entry) => withoutSignedLinkFields(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !CANVAS_SIGNED_LINK_FIELDS.includes(key)));
}

function withoutCanvasSignedLinks(result, semantic) {
  return semantic?.target.object === "file" && result?.data !== undefined
    ? { ...result, data: withoutSignedLinkFields(result.data) }
    : result;
}

function canvasOperationList() {
  return [...state.operations.values()].filter((entry) => entry.provider === "canvas");
}

/** The declared object-to-course binding for one Canvas write, with the object this call names. */
function canvasSemanticWrite(command, operation) {
  if (command.kind !== "invoke_write" || operation.provider !== "canvas") return null;
  const courseTarget = canvasOperationAdmission(operation).courseTarget;
  if (courseTarget.kind !== "semantic_course_object") return null;
  const target = courseTarget.target;
  const args = command.arguments || {};
  return {
    target,
    objectId: target.objectParameter ? decimalId(args[target.objectParameter]) : "",
    destination: target.destinationParameter ? args[target.destinationParameter] : undefined,
    arguments: args,
  };
}

function namedInput(value) {
  return value !== undefined && value !== null && value !== "";
}

/**
 * The inputs Morrow will not send at all, and the ones it sends only with the one value that keeps
 * the change to what was asked for, with the sentence for each. Canvas answers a name clash in the
 * destination folder by overwriting the file already there unless it is told to keep both, and that
 * would remove a file nobody asked to remove. A required value is required only of a route that
 * accepts the input.
 */
function canvasSemanticInputProblem(semantic, operation) {
  if ((semantic.target.refusedParameters || []).some((name) => namedInput(semantic.arguments[name]))) {
    return `This change names a second place for the ${semantic.target.object}, and Morrow sends it only to the one it read. It changed nothing.`;
  }
  // Canvas takes a repeat rule, a duplicate count and a series choice on the same request, and each
  // of them reaches events beyond the one Morrow reads back afterwards.
  if (canvasSemanticSeriesInput(semantic.target, semantic.arguments)) {
    return `Morrow changes one ${semantic.target.object} and reads that one back. This change would repeat, copy or extend it across a series Morrow cannot check, so it changed nothing.`;
  }
  const accepted = new Set((operation.parameters || []).map((parameter) => parameter.inputName));
  const missing = Object.entries(semantic.target.requiredInputs || {})
    .some(([name, value]) => accepted.has(name) && String(semantic.arguments[name] ?? "") !== value);
  return missing
    ? `Canvas replaces a file that already has this name unless it is told to keep both, so Morrow sends this change only with that instruction. It changed nothing.`
    : "";
}

/**
 * The selected course's own listing, read to its last page. A Canvas group is read back from the
 * course itself as well as from the group, because a group read says which course Canvas has
 * recorded and the course listing says the course still holds that group. A calendar is asked for
 * by its context code and for the whole of it, and every entry has to name that same calendar: a
 * listing Canvas did not narrow to this course says nothing about what the course holds.
 */
async function canvasSemanticCourseCollection(binding, semantic) {
  const collection = state.operations.get(semantic.target.courseCollectionRead);
  const args = canvasSemanticCourseCollectionArguments(semantic.target, binding.courseId);
  if (collection?.provider !== "canvas" || collection.readOnly !== true || Object.keys(args).length === 0) {
    return { collection: null, state: "unreadable" };
  }
  const listed = await executeOperation(binding, collection, args);
  return { collection, state: canvasSemanticCourseCollectionState(semantic.target, listed, semantic.objectId, binding.courseId) };
}

/**
 * Reads the object in the bound tab and freezes what that reading proves. Morrow sends the change
 * only when this exact object is the selected course's own. Nothing has been sent when this
 * refuses, so the request stays free for another attempt.
 */
async function resolveCanvasSemanticTarget(binding, operation, semantic) {
  const refused = problem(
    "canvas_semantic_target_course_mismatch",
    `Morrow could not confirm that this Canvas ${semantic.target.object} belongs to the selected course, so it changed nothing.`,
    true,
  );
  const multiContext = problem(
    CANVAS_MULTI_CONTEXT_REFUSAL,
    `This Canvas ${semantic.target.object} serves more than one course. Morrow changes one course at a time, so it changed nothing. Change it in Canvas, or use one that belongs to this course alone.`,
    true,
  );
  const inputProblem = canvasSemanticInputProblem(semantic, operation);
  if (inputProblem) return { failure: problem("canvas_semantic_target_input_refused", inputProblem, true) };
  // The calendar this change names is its own fact: a create says where the new object lands, and a
  // change to an existing object can move it to another calendar. Either way Morrow sends it only
  // when it names the selected course, and it refuses more than one course outright.
  const namedContext = canvasSemanticContextInputState(semantic.target, semantic.arguments, binding.courseId);
  if (namedContext === "multi_context") return { failure: multiContext };
  if (namedContext === "other_context") return { failure: refused };
  // A route that creates the object has nothing to read first: that input is the whole binding, and
  // the reading taken after the change proves the new object landed on this course's calendar.
  if (semantic.target.createsObject) {
    return namedContext === "selected_course" ? { resolution: null } : { failure: refused };
  }
  const destinationNamed = namedInput(semantic.destination);
  const destinationId = destinationNamed ? decimalId(semantic.destination) : "";
  if (destinationNamed && !destinationId) return { failure: refused };
  const readOperation = state.operations.get(semantic.target.resolverRead);
  if (!semantic.objectId || readOperation?.provider !== "canvas" || readOperation.readOnly !== true) return { failure: refused };
  const readParameter = semantic.target.readParameter || semantic.target.objectParameter;
  const read = await executeOperation(binding, readOperation, { [readParameter]: semantic.objectId });
  const context = canvasSemanticObjectContext(semantic.target, read, semantic.objectId);
  if (context.state === "multi_context") return { failure: multiContext };
  if (context.state !== "course" || context.courseId !== binding.courseId) return { failure: refused };
  if (semantic.target.courseCollectionProof === true) {
    const listing = await canvasSemanticCourseCollection(binding, semantic);
    if (listing.state !== "listed") return { failure: refused };
  }
  // Where the change lands is its own object, so it is proved from the course side as well: the
  // selected course's own complete listing has to name the destination before anything is sent.
  if (destinationId && !await canvasSemanticDestinationListed(binding, semantic.target, destinationId)) {
    return { failure: refused };
  }
  const version = canvasSemanticObjectVersion(semantic.target, read, semantic.objectId);
  const resolution = {
    objectId: semantic.objectId,
    courseId: binding.courseId,
    resolverTool: semantic.target.resolverRead,
    resolvedAt: new Date().toISOString(),
    snapshotDigest: await sha256(JSON.stringify(read.data)),
    ...(version ? { objectVersion: version } : {}),
    ...(destinationId ? { destinationId } : {}),
  };
  const invalid = canvasSemanticResolutionProblem(semantic.target, resolution, {
    objectId: semantic.objectId,
    courseId: binding.courseId,
    now: Date.now(),
    ...(destinationId ? { destinationId } : {}),
  });
  if (!invalid) return { resolution };
  return { failure: problem(invalid, `Morrow could not freeze a current reading of this Canvas ${semantic.target.object}, so it changed nothing.`, true) };
}

/**
 * The folder a file moves into, read from the selected course's own complete list of folders. A list
 * that could not be read to its last page is not proof.
 */
async function canvasSemanticDestinationListed(binding, target, destinationId) {
  const collection = state.operations.get(target.destinationCollectionRead);
  if (collection?.provider !== "canvas" || collection.readOnly !== true) return false;
  const listed = await executeOperation(binding, collection, { course_id: binding.courseId });
  return canvasSemanticCourseCollectionState(target, listed, destinationId) === "listed";
}

function semanticVerification(status, plan, detail) {
  return {
    schema: "morrow.browser-verification.v1",
    status,
    strategy: plan.strategy,
    readTool: plan.readOperation.toolName,
    ...detail,
  };
}

/**
 * Proves a deletion from the selected course's own listing when the object route still answers.
 * A listing that could not be read to its last page proves nothing either way.
 */
async function verifyCanvasSemanticAbsence(binding, semantic, fallback) {
  const listing = await canvasSemanticCourseCollection(binding, semantic);
  if (!listing.collection) return fallback;
  const plan = { strategy: "collection-omits-target", readOperation: listing.collection };
  if (listing.state === "unreadable") return semanticVerification("unconfirmed", plan, { evidence: "collection_readback_incomplete" });
  return listing.state === "listed"
    ? semanticVerification("mismatch", plan, { evidence: "target_still_present" })
    : semanticVerification("verified", plan, { evidence: "fresh_collection_omits_target" });
}

/**
 * The planned readback names the proved object: the object's own read, which is what a change to the
 * object itself is checked with; a read inside that same object, which is what a change to the
 * object's own content is checked with; or the read of an object this change created inside the
 * proved one.
 */
function canvasSemanticReadbackTarget(plan, semantic) {
  const readParameter = semantic.target.readParameter || semantic.target.objectParameter || "";
  const readId = readParameter ? decimalId(plan.arguments?.[readParameter]) : "";
  const ownRoute = plan.readOperation.toolName === semantic.target.resolverRead;
  const createdId = decimalId(plan.targetId);
  // A route that creates the object has nothing to prove beforehand, so the object it created is
  // read through the same route an existing one is read through, where Canvas names the calendar
  // that now holds it.
  if (semantic.target.createsObject) return ownRoute && createdId && readId === createdId ? "created_object" : "";
  if (readId === semantic.objectId) return ownRoute ? "object" : "content";
  return ownRoute && readId && readId === createdId && semantic.target.childParentField ? "created_child" : "";
}

/**
 * Canvas answers some changes under another name than the one they were asked for: a file's new name
 * is asked for as a name and saved as its display name, and its destination folder is asked for as a
 * parent and saved as the folder it is in. Canvas acts on the rest without keeping them, so nothing
 * reads them back.
 */
function canvasSemanticPlan(plan, semantic) {
  const names = semantic.target.readbackFields || {};
  const unsaved = semantic.target.unsavedInputs || [];
  if (Object.keys(names).length === 0 && unsaved.length === 0) return plan;
  return {
    ...plan,
    assertions: plan.assertions
      .filter((assertion) => !unsaved.includes(assertion.inputName))
      .map((assertion) => names[assertion.inputName] ? { ...assertion, paths: [[names[assertion.inputName]]] } : assertion),
  };
}

/**
 * Reads the changed thing again through its own route, compares the requested fields, and keeps the
 * reading inside the object the resolution proved. A change to the object itself has to come back as
 * the same saved object the frozen reading named, and an object this change created has to name that
 * proved object as its parent. A deletion of the object itself is also proved against the selected
 * course's own listing when the object's route still answers.
 */
async function verifyCanvasSemanticWrite(binding, operation, args, writeData, semantic, resolution) {
  const planned = planBrowserReadback(canvasOperationList(), operation, args, writeData);
  const plan = planned ? canvasSemanticPlan(planned, semantic) : null;
  const target = plan ? canvasSemanticReadbackTarget(plan, semantic) : "";
  if (!target) return { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "no_safe_readback_route" };
  const readback = await executeOperation(binding, plan.readOperation, plan.arguments);
  const verification = evaluateBrowserReadback(plan, readback);
  if (operation.method === "DELETE" && target === "object") {
    return verification.status === "verified" ? verification : await verifyCanvasSemanticAbsence(binding, semantic, verification);
  }
  if (verification.status !== "verified" || target === "content") return verification;
  const readObjectId = ["created_child", "created_object"].includes(target) ? decimalId(plan.targetId) : semantic.objectId;
  if (canvasSemanticResolvedCourseId(semantic.target, readback, readObjectId) !== binding.courseId) {
    return semanticVerification("mismatch", plan, { evidence: "canvas_semantic_target_course_mismatch" });
  }
  // The new object's own reading has just named the selected course, which is the whole binding a
  // created object needs.
  if (target === "created_object") return verification;
  if (target === "created_child") {
    return decimalId(readback.data?.[semantic.target.childParentField]) === semantic.objectId
      ? verification
      : semanticVerification("mismatch", plan, { evidence: "canvas_semantic_target_course_mismatch" });
  }
  if (!resolution?.objectVersion) return verification;
  const version = canvasSemanticVersionState(semantic.target, resolution.objectVersion, readback, semantic.objectId);
  if (version === "same_object") return verification;
  return semanticVerification(version === "changed" ? "mismatch" : "unconfirmed", plan, {
    evidence: version === "changed" ? "object_version_changed" : "object_version_not_returned",
  });
}

function genericCanvasWriteReadback(command, operation, privateConversation) {
  return command.kind === "invoke_write"
    && operation.provider === "canvas"
    && !command.arguments?.morrow_canvas_content_guard
    && !command.arguments?.morrow_page_guard
    && !privateConversation
    && !privateCanvasCourseFileOperation(operation)
    && !isCanvasOperationReadback(operation);
}

// The read-only comparator Morrow keeps with the operation record. It carries
// the catalog route, its id arguments and the approved field values, so an
// unresolved change can be checked later without ever being sent again.
function canvasRecoveryDescriptor(operation, args, writeData) {
  try {
    return planCanvasRecoveryDescriptor(
      [...state.operations.values()].filter((entry) => entry.provider === "canvas"),
      operation,
      args,
      writeData,
    );
  } catch {
    return null;
  }
}

/**
 * The setup guide reports a first course read only after one happened, so this records the course
 * one successful read reached and when. The record is replaced when a read succeeds in a different
 * course. It proves nothing to Morrow and gates nothing: it is what the guide reads instead of
 * calling a connection a completed setup.
 */
async function recordCourseRead(binding) {
  const record = {
    provider: binding.provider,
    origin: binding.origin,
    courseId: String(binding.courseId || ""),
    courseName: String(binding.courseName || "").trim().slice(0, 200),
    at: Date.now(),
  };
  await queueStorageMutation(async () => {
    const { firstCourseRead } = await chrome.storage.local.get("firstCourseRead");
    if (firstCourseRead?.provider === record.provider
      && firstCourseRead?.origin === record.origin
      && firstCourseRead?.courseId === record.courseId) return;
    await chrome.storage.local.set({ firstCourseRead: record });
  });
}

/**
 * Opens the offscreen document that holds the sandboxed render-check page. A
 * service worker has no document of its own, so it cannot hold that frame.
 */
async function ensureRenderCheckDocument() {
  if (typeof chrome.offscreen?.createDocument !== "function") return false;
  renderCheckDocument ??= (async () => {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: RENDER_CHECK_DOCUMENT_PATH,
      reasons: ["DOM_PARSER"],
      justification: "Parse one saved course HTML field into a detached document for accessibility render checks.",
    });
  })();
  try {
    await renderCheckDocument;
    return true;
  } catch {
    renderCheckDocument = null;
    return false;
  }
}

/** Closes the offscreen document once reading stops, so nothing is kept open between sessions. */
function scheduleRenderCheckClose() {
  if (renderCheckIdleTimer !== null) clearTimeout(renderCheckIdleTimer);
  renderCheckIdleTimer = setTimeout(() => {
    renderCheckIdleTimer = null;
    renderCheckDocument = null;
    void chrome.offscreen?.closeDocument?.().catch(() => undefined);
  }, RENDER_CHECK_IDLE_MS);
}

/**
 * Runs the learner-render checks for the one saved HTML field a Canvas read
 * carries. The HTML never leaves the extension: it goes to a sandboxed page
 * whose content security policy forbids every network load, and what comes back
 * is a signal record of indexes and counts with no course text in it.
 *
 * A read that carries no HTML field, an oversized field, or an unavailable
 * sandbox produces no record at all. `course-audit.ts` then reports the render
 * evidence as not observed rather than as a passed check.
 */
async function savedHtmlRenderCheck(command, operation, result) {
  if (command.kind !== "invoke_read" || operation.provider !== "canvas" || result?.ok !== true || result.truncated === true) return null;
  const target = renderCheckField(result.data);
  if (!target || target.value.length > MAX_RENDER_CHECK_SOURCE_CHARS) return null;
  if (renderCheckIdleTimer !== null) { clearTimeout(renderCheckIdleTimer); renderCheckIdleTimer = null; }
  if (!await ensureRenderCheckDocument()) return null;
  try {
    const answer = await chrome.runtime.sendMessage({ type: RENDER_CHECK_MESSAGE_TYPE, field: target.field, html: target.value });
    return answer?.ok === true && answer.record?.schema === RENDER_CHECK_SCHEMA ? answer.record : null;
  } catch {
    return null;
  } finally {
    scheduleRenderCheckClose();
  }
}

async function sendExecution(command, binding, operation, privateAttachment, privateConversation, privateAttachments) {
  const semantic = canvasSemanticWrite(command, operation);
  let semanticResolution = null;
  if (semantic) {
    const resolved = await resolveCanvasSemanticTarget(binding, operation, semantic);
    if (resolved.failure) {
      sendResult(command, false, null, resolved.failure);
      return "known";
    }
    semanticResolution = resolved.resolution;
  }
  const dispatched = semanticResolution ? { ...operation, morrowSemanticResolution: semanticResolution } : operation;
  const result = await executeOperation(binding, dispatched, command.arguments || {}, command.expiresAt, privateAttachment, privateConversation, privateAttachments);
  // A change can move the course site tab itself, so nothing kept from before it is used again.
  if (command.kind === "invoke_write") forgetSiteAnchorVerification(binding.siteAnchorId);
  if (!result?.ok) {
    const unknown = result?.outcomeUnknown === true || (result?.sent === true && command.kind === "invoke_write" && (
      !Number.isInteger(result.status)
      || (operation.provider === "moodle" && result.verification?.status !== "verified" && result.error !== "moodle_form_validation_failed")
    ));
    const message = privateCanvasCourseFileOperation(operation)
      ? "Canvas could not complete the staged file change."
      : privateAttachment || privateAttachments
        ? "Moodle could not complete the staged file change."
        : privateConversation
        ? "Canvas could not complete the Inbox message."
        : errorMessage(result?.error || `Canvas returned HTTP ${result?.status || 0}`).slice(0, 900);
    // An unknown outcome is exactly the case a later check has to resolve, so the
    // comparator is retained here too. Only the arguments are available; a create
    // keeps the parent-collection read that can still show a duplicate.
    const unresolvedDescriptor = unknown && genericCanvasWriteReadback(command, operation, privateConversation)
      ? canvasRecoveryDescriptor(operation, command.arguments || {}, undefined)
      : null;
    // The status decides the code here rather than the page result's own
    // outcome field, because an in-page executor runs in a world the site can
    // reach. A claim of uncertainty is still honoured: it only ever holds a
    // change back.
    const code = bridgeWriteFailureCode({
      unknown,
      sent: result?.sent,
      provider: operation.provider,
      kind: command.kind,
      status: result?.status,
    });
    sendResult(
      command,
      false,
      unresolvedDescriptor ? { schema: "morrow.canvas-browser-result.v1", readDescriptor: unresolvedDescriptor } : null,
      problem(code, message, !unknown),
    );
    return unknown ? "unknown" : "known";
  }
  let verification;
  let readDescriptor = null;
  if (command.kind === "invoke_write") {
    const guardedCanvasContent = command.arguments?.morrow_canvas_content_guard;
    const guardedPage = command.arguments?.morrow_page_guard;
    // A guarded Item Bank repair reads the question again inside the Item Banks
    // frame, because only that frame holds the credential the read needs. Its
    // own answer is the verification; no second route can produce one.
    const guardedItemBank = operation.service === "item_bank" && command.arguments?.morrow_item_bank_guard !== undefined;
    const dueDateOnlyAssignment = operation.provider === "canvas" && operation.toolName === "canvas_edit_assignment"
      && Object.hasOwn(command.arguments || {}, "assignment_due_at")
      && Object.keys(command.arguments || {}).every((field) => ["course_id", "id", "assignment_due_at"].includes(field));
    const namedCanvasReadback = operation.provider === "canvas" && isCanvasOperationReadback(operation);
    const semanticReadback = Boolean(semantic) && !guardedCanvasContent && !guardedPage && !privateConversation && !namedCanvasReadback;
    const namedPlan = namedCanvasReadback
      ? planCanvasOperationReadback([...state.operations.values()].filter((entry) => entry.provider === "canvas"), operation, command.arguments || {}, result.data)
      : null;
    const plan = guardedCanvasContent || guardedPage || guardedItemBank || privateConversation || privateCanvasCourseFileOperation(operation) || operation.provider !== "canvas" || namedCanvasReadback || semanticReadback ? null : planBrowserReadback([...state.operations.values()].filter((entry) => entry.provider === "canvas"), operation, command.arguments || {}, result.data);
    readDescriptor = genericCanvasWriteReadback(command, operation, privateConversation)
      ? canvasRecoveryDescriptor(operation, command.arguments || {}, result.data)
      : null;
    if (operation.provider === "moodle") {
      verification = result.verification || { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_verification_missing" };
    } else if (guardedCanvasContent) {
      verification = result.verification || { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "canvas_content_verification_missing" };
    } else if (guardedPage) {
      verification = result.verification || { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "page_verification_missing" };
    } else if (guardedItemBank) {
      verification = result.verification || { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "item_bank_verification_missing" };
    } else if (dueDateOnlyAssignment) {
      verification = result.verification || { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "assignment_due_date_verification_missing" };
    } else if (namedCanvasReadback) {
      verification = namedPlan
        ? await executeNamedCanvasReadback(binding, namedPlan)
        : { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "canvas_operation_readback_plan_unavailable" };
    } else if (privateConversation) {
      verification = result.verification || { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "canvas_conversation_verification_missing" };
    } else if (privateCanvasCourseFileOperation(operation)) {
      verification = result.verification || { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "canvas_file_transfer_verification_missing" };
    } else if (semanticReadback) {
      verification = await verifyCanvasSemanticWrite(binding, operation, command.arguments || {}, result.data, semantic, semanticResolution);
    } else if (plan) {
      const readback = await executeOperation(binding, plan.readOperation, plan.arguments);
      verification = evaluateBrowserReadback(plan, readback);
    } else {
      verification = { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "no_safe_readback_route" };
    }
  }
  const publicResult = withoutCanvasSignedLinks(
    privateAttachment || privateAttachments || privateConversation ? withoutPrivateAttachment(result) : result,
    semantic,
  );
  const renderCheck = await savedHtmlRenderCheck(command, operation, publicResult);
  sendResult(command, true, { schema: "morrow.canvas-browser-result.v1", ...publicResult, provider: operation.provider, ...(verification ? { verification } : {}), ...(readDescriptor ? { readDescriptor } : {}), ...(semanticResolution ? { semanticResolution } : {}), ...(renderCheck ? { renderCheck } : {}) }, null);
  // The answer is already sent. A storage failure here loses one setup-guide line, never a result.
  if (command.kind === "invoke_read") await recordCourseRead(binding).catch(() => undefined);
  return "known";
}

async function sendCheckedCommand(command, context) {
  if (context.failure) return sendResult(command, false, null, context.failure);
  return await sendExecution(command, context.binding, context.operation, context.privateAttachment, context.privateConversation, context.privateAttachments);
}

async function reserveWriteAtHead(command) {
  return await queueStorageMutation(async () => {
    const context = await commandContext(command);
    if (context.failure) return context;
    const refusal = await reserveReceiptNow(command);
    if (refusal) return { failure: refusal };
    return context;
  });
}

async function handleQueuedWrite(command) {
  const reservation = await reserveWriteAtHead(command);
  if (reservation.failure) {
    sendResult(command, false, null, reservation.failure);
    return "known";
  }
  const beforeSend = await commandContext(command);
  if (beforeSend.failure) {
    sendResult(command, false, null, beforeSend.failure);
    return "known";
  }
  return await sendExecution(command, beforeSend.binding, beforeSend.operation, beforeSend.privateAttachment, beforeSend.privateConversation, beforeSend.privateAttachments);
}

function maintenanceCode(error) {
  return error instanceof BridgeMaintenanceError ? error.code : "bridge_maintenance_unavailable";
}

async function handleTrackedWrite(command) {
  const effectReceiptId = command.outerGrant?.effectReceiptId;
  try {
    await bridgeMaintenance.beginWrite({ operationId: command.operationId, effectReceiptId });
  } catch (error) {
    return sendResult(command, false, null, problem(maintenanceCode(error), "Morrow cannot begin this course change while Bridge update status is uncertain.", true));
  }
  let outcome = "unknown";
  try {
    const context = await commandContext(command);
    if (context.failure) {
      outcome = "known";
      return sendResult(command, false, null, context.failure);
    }
    outcome = await queueBindingWrite(context.binding.sourceBindingId, () => handleQueuedWrite(command));
  } catch {
    return sendResult(command, false, null, problem("write_outcome_unknown", "Morrow could not determine the result of this course change. Check the existing course before another change.", false));
  } finally {
    try { await bridgeMaintenance.finishWrite(command.operationId, outcome); } catch { /* The durable receipt remains a safe update fence. */ }
  }
}

async function handleCommand(command) {
  if (command.kind === "invoke_write") return await handleTrackedWrite(command);
  const context = await commandContext(command);
  if (context.failure) return sendResult(command, false, null, context.failure);
  return await sendCheckedCommand(command, context);
}

async function handleEditPolicySet(command) {
  try {
    const result = await applyBridgePolicySet(bridgePolicySet(command));
    return sendResult(command, true, result, null);
  } catch (error) {
    const code = policyCode(error);
    return sendResult(command, false, null, problem(code, "Morrow could not apply the selected course Edit policy.", code !== "edit_policy_set_stale"));
  }
}

async function handleEditPolicyOptionsGet(command) {
  try {
    const sourceBindingId = bridgePolicyOptionsGet(command);
    return sendResult(command, true, await editPolicyOptions(sourceBindingId), null);
  } catch (error) {
    const code = policyCode(error);
    return sendResult(command, false, null, problem(code, "Morrow could not read the selected course Edit actions.", code !== "edit_policy_options_stale"));
  }
}

async function handleBridgeMaintenance(command) {
  try {
    return sendResult(command, true, await bridgeMaintenance.control(command.maintenance), null);
  } catch (error) {
    return sendResult(command, false, null, problem(maintenanceCode(error), "Morrow could not complete the private Bridge update control.", false));
  }
}

async function handleBridgeMessage(message) {
  if (message?.schema === "morrow.bridge.ready.v1") {
    // Morrow answers the connection request with the connector identity it accepted. Keeping that
    // answer lets status() compare it with what this extension is now, instead of treating an open
    // connection as proof that the two are the same build.
    state.accepted = {
      generation: message.generation,
      extensionId: message.acceptedExtensionId,
      catalogDigest: message.catalogDigest,
      runtimeRevision: RUNTIME_REVISION,
    };
    state.generation = message.generation;
    return;
  }
  if (message?.schema === "morrow.bridge.ping.v1" && message.generation === state.generation) {
    state.socket?.send(JSON.stringify({ schema: "morrow.bridge.pong.v1", protocolVersion: PROTOCOL_VERSION, generation: state.generation, sentAt: Date.now() }));
    return;
  }
  if (message?.schema === "morrow.bridge.command.v1") {
    if (message.kind === "edit_policy_set") await handleEditPolicySet(message);
    else if (message.kind === "edit_policy_options_get") await handleEditPolicyOptionsGet(message);
    else if (message.kind === "bridge_maintenance") await handleBridgeMaintenance(message);
    else await handleCommand(message);
  }
}

async function requestPairing() {
  const api = await catalog();
  const response = await fetch(httpUrl("/pair"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extensionId: chrome.runtime.id, catalogDigest: api.catalogDigest, runtimeRevision: RUNTIME_REVISION }),
  });
  if (!response.ok) {
    if (response.status === 403) {
      const body = await response.json().catch(() => null);
      if (body?.error === "connector_identity_refused") {
        throw new Error("bridge_version_mismatch");
      }
    }
    throw new Error("bridge_not_connected");
  }
  const pairing = await response.json();
  await chrome.storage.local.set({ pairing });
  await chrome.alarms.create("morrow-pairing", { periodInMinutes: 0.5 });
  await chrome.tabs.create({ url: pairing.approvalUrl });
  return pairing;
}

async function pollPairing() {
  const { pairing } = await storage();
  if (!pairing?.statusUrl || !Number.isFinite(pairing.expiresAt) || Date.now() >= pairing.expiresAt) {
    const latest = await storage();
    if (latest.pairing?.statusUrl !== pairing?.statusUrl) return;
    await chrome.storage.local.remove("pairing");
    await chrome.alarms.clear("morrow-pairing");
    return;
  }
  const response = await fetch(pairing.statusUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extensionId: chrome.runtime.id }),
  }).catch(() => null);
  if (response?.status === 404 || response?.status === 410) {
    const latest = await storage();
    if (latest.pairing?.statusUrl !== pairing.statusUrl) return;
    await chrome.storage.local.remove("pairing");
    await chrome.alarms.clear("morrow-pairing");
    return;
  }
  if (!response?.ok) return;
  const status = await response.json();
  if (status.status === "approved" && status.token) {
    const latest = await storage();
    if (latest.pairing?.statusUrl !== pairing.statusUrl) return;
    await chrome.storage.local.set({ token: status.token, pairing: null });
    await chrome.alarms.clear("morrow-pairing");
    await connectBridge();
  } else if (status.status === "denied" || Date.now() >= status.expiresAt) {
    const latest = await storage();
    if (latest.pairing?.statusUrl !== pairing.statusUrl) return;
    await chrome.storage.local.set({ pairing: null });
    await chrome.alarms.clear("morrow-pairing");
  }
}

async function permissionOrigins(tabId, tabUrl) {
  const permissionPattern = (value) => {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}/*`;
  };
  const origins = new Set([permissionPattern(tabUrl)]);
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
  for (const frame of frames || []) {
    try {
      const url = new URL(frame.url);
      if (ITEM_BANK_FRAME_HOST_PATTERN.test(url.hostname)) origins.add(permissionPattern(url.href));
    } catch {}
  }
  return [...origins];
}

async function preparedCourseConnection(intentId, { addedOrigins, popupConfirmed = false } = {}) {
  const stored = await chrome.storage.local.get(COURSE_CONNECTION_INTENT_KEY);
  const intent = stored[COURSE_CONNECTION_INTENT_KEY];
  const tab = await chrome.tabs.get(intent?.tabId).catch(() => null);
  if (!validCourseConnectionIntent(intent, Date.now(), COURSE_CONNECTION_INTENT_TTL_MS)
    || !canCompleteCourseConnectionIntent(intent, { intentId, tabId: tab?.id, url: tab?.url, permissionOrigins: intent?.origins || [], addedOrigins, popupConfirmed, ttlMs: COURSE_CONNECTION_INTENT_TTL_MS })) return null;
  if (!await chrome.permissions.contains({ origins: intent.origins })) return null;
  return intent;
}

async function prepareCourseConnection(requestedTabId) {
  const tab = Number.isInteger(requestedTabId)
    ? await chrome.tabs.get(requestedTabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  const url = normalizeCourseConnectionUrl(tab?.url);
  if (!tab?.id || !url) throw new Error("course_tab_missing");
  const origins = await permissionOrigins(tab.id, tab.url);
  const preGrantedOrigins = [];
  for (const origin of origins) {
    if (await chrome.permissions.contains({ origins: [origin] })) preGrantedOrigins.push(origin);
  }
  const intent = { id: crypto.randomUUID(), tabId: tab.id, url, origins, preGrantedOrigins, createdAt: Date.now() };
  await chrome.storage.local.set({ [COURSE_CONNECTION_INTENT_KEY]: intent });
  return intent;
}

async function completePreparedCourseConnection({ intentId, addedOrigins, popupConfirmed = false, openCourseSelection = false } = {}) {
  const pending = await preparedCourseConnection(intentId, { addedOrigins, popupConfirmed });
  if (!pending) return { completed: false };
  const intent = await queueStorageMutation(async () => {
    const stored = await chrome.storage.local.get(COURSE_CONNECTION_INTENT_KEY);
    const candidate = stored[COURSE_CONNECTION_INTENT_KEY];
    const tab = await chrome.tabs.get(candidate?.tabId).catch(() => null);
    if (!canClaimCourseConnectionIntent(candidate, { intentId, tabId: tab?.id, url: tab?.url, permissionOrigins: pending.origins, ttlMs: COURSE_CONNECTION_INTENT_TTL_MS })) return null;
    await chrome.storage.local.remove(COURSE_CONNECTION_INTENT_KEY);
    return candidate;
  });
  if (!intent) return { completed: false };
  let result;
  try {
    result = await connectCourseTab(intent.tabId, intent.url);
  } catch (error) {
    // Morrow connects Blackboard through the REST connection in the Morrow app, so this site can
    // never connect in Chrome and trying again cannot change that. The access the person just
    // allowed for it goes back, rather than being kept for a route Morrow refuses. Every other
    // refusal here can be tried again after the person fixes it, and keeping the access is what
    // spares them a second Chrome request.
    if (messageCode(error) === "blackboard_browser_unsupported") await releaseGrantedConnectionOrigins(intent);
    throw error;
  }
  if (openCourseSelection && result?.siteAnchorId) await chrome.runtime.openOptionsPage().catch(() => {});
  return result;
}

/** Gives back the site access this connection was granted, keeping whatever Morrow already had. */
async function releaseGrantedConnectionOrigins(intent) {
  const granted = (intent?.origins || []).filter((origin) => !(intent?.preGrantedOrigins || []).includes(origin));
  if (granted.length === 0) return;
  await chrome.permissions.remove({ origins: granted }).catch(() => {});
}


async function cancelPreparedCourseConnection(intentId) {
  await queueStorageMutation(async () => {
    const stored = await chrome.storage.local.get(COURSE_CONNECTION_INTENT_KEY);
    if (stored[COURSE_CONNECTION_INTENT_KEY]?.id === intentId) await chrome.storage.local.remove(COURSE_CONNECTION_INTENT_KEY);
  });
  return { cancelled: true };
}

async function connectCourseTab(requestedTabId, expectedUrl) {
  const tab = Number.isInteger(requestedTabId)
    ? await chrome.tabs.get(requestedTabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab?.id || !tab.url?.startsWith("https://") || (expectedUrl && normalizeCourseConnectionUrl(tab.url) !== expectedUrl)) throw new Error("course_tab_missing");
  const origins = await permissionOrigins(tab.id, tab.url);
  if (!await chrome.permissions.contains({ origins })) throw new Error("course_site_access_required");
  const [moodle] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: "MAIN", func: executeMoodleInPage, args: [JSON.stringify({ mode: "probe" })] });
  let profile = moodle?.result?.ok === true ? moodle.result.profile : null;
  if (!profile) {
    if (/^\/(?:ultra|webapps)(?:\/|$)/.test(new URL(tab.url).pathname)) throw new Error("blackboard_browser_unsupported");
    await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ["src/canvas-content.js"] });
    const probe = await chrome.tabs.sendMessage(tab.id, { type: "morrow_canvas_probe" }, { frameId: 0 });
    if (!probe?.ok) throw new Error("course_sign_in_required");
    profile = { ...probe.profile, provider: "canvas", principalId: probe.profile.id };
  }
  const digest = await sha256(`${profile.provider}\0${profile.siteUrl || profile.origin}\0${profile.principalId}`);
  const anchorBase = {
    provider: profile.provider,
    origin: profile.origin,
    ...(profile.siteUrl ? { siteUrl: profile.siteUrl } : {}),
    principalFingerprint: digest,
    runtimeVerified: true,
    lastSeenAt: Date.now(),
    principalId: profile.principalId,
    tabId: tab.id,
  };
  const anchor = await queueStorageMutation(async () => {
    if (expectedUrl) {
      const latest = await chrome.tabs.get(tab.id).catch(() => null);
      if (normalizeCourseConnectionUrl(latest?.url) !== expectedUrl) throw new Error("course_tab_missing");
    }
    const stored = await storage();
    const sameSite = [...storedAnchors(stored.siteAnchors), ...(stored.bindings || [])].filter((candidate) => sameSitePrincipal(candidate, anchorBase));
    const sessionGeneration = sameSite.reduce((greatest, candidate) => (
      Math.max(greatest, Number.isInteger(candidate.sessionGeneration) ? candidate.sessionGeneration : 0)
    ), 0) + 1;
    const next = { ...anchorBase, sessionGeneration, siteAnchorId: `${profile.provider}:${digest.slice(0, 20)}:g${sessionGeneration}` };
    const replaced = (stored.bindings || []).filter((candidate) => sameSitePrincipal(candidate, next));
    const bindings = (stored.bindings || []).filter((candidate) => !sameSitePrincipal(candidate, next));
    const editPolicies = { ...storedPolicies(stored.editPolicies) };
    for (const prior of replaced) delete editPolicies[prior.sourceBindingId];
    const siteAnchors = [...storedAnchors(stored.siteAnchors).filter((candidate) => !sameSitePrincipal(candidate, next)), next];
    const saved = await discoveries();
    const courseDiscoveries = Object.fromEntries(Object.entries(storedDiscoveries(saved.courseDiscoveries)).filter(([, receipt]) => !sameSitePrincipal(receipt, next)));
    await chrome.storage.local.set({ bindings, siteAnchors, editPolicies });
    await discoveryArea().set({ courseDiscoveries });
    return next;
  });
  await publishBindings();
  return { siteAnchorId: anchor.siteAnchorId, provider: anchor.provider, origin: anchor.origin, ...(anchor.siteUrl ? { siteUrl: anchor.siteUrl } : {}), sessionGeneration: anchor.sessionGeneration };
}

/**
 * Whether the Morrow this connection reached is the same build as this Chrome extension. Morrow
 * names the connector identity it accepted in its ready answer, and this compares that answer with
 * what the extension is now: this exact extension, this connector revision, and this exact list of
 * course actions. An open connection on its own never stands for that.
 */
function runtimeHealthy(connected) {
  const accepted = state.accepted;
  if (!connected || !accepted || accepted.generation !== state.generation) return false;
  return accepted.extensionId === chrome.runtime.id
    && accepted.runtimeRevision === RUNTIME_REVISION
    && Boolean(state.catalog?.catalogDigest)
    && accepted.catalogDigest === state.catalog.catalogDigest;
}

async function status() {
  const before = await storage();
  if (before.pairing?.status === "pending") await pollPairing();
  const stored = await storage();
  const bindings = await publicBindings();
  const siteAnchors = await publicSiteAnchors(stored);
  const connected = state.socket?.readyState === WebSocket.OPEN && state.generation > 0;
  const { firstCourseRead = null } = await chrome.storage.local.get("firstCourseRead");
  return {
    paired: Boolean(stored.token),
    pairing: stored.pairing?.status === "pending",
    connecting: state.socket?.readyState === WebSocket.CONNECTING || (state.socket?.readyState === WebSocket.OPEN && state.generation === 0),
    connected,
    runtimeHealthy: runtimeHealthy(connected),
    firstCourseRead,
    anchorCount: siteAnchors.length,
    siteAnchors,
    bindingCount: bindings.length,
    bindings: bindings.map((binding) => ({ sourceBindingId: binding.sourceBindingId, provider: binding.provider, origin: binding.origin, siteUrl: binding.siteUrl, courseId: binding.courseId, courseName: binding.courseName, runtimeVerified: binding.runtimeVerified, lastSeenAt: binding.lastSeenAt })),
  };
}

async function openSetupGuide() {
  await chrome.tabs.create({ url: chrome.runtime.getURL(SETUP_GUIDE_PATH) });
  return { opened: true };
}

async function disconnectConnector() {
  anchorVerifications.clear();
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  const socket = state.socket;
  state.socket = null;
  state.generation = 0;
  state.accepted = null;
  socket?.close(1000, "user_disconnected");
  await chrome.alarms.clear("morrow-pairing");
  await queueStorageMutation(async () => {
    // The course file access opt-in goes with the connection. Every file read already re-checks the
    // Chrome permission, so this is state hygiene, not a new boundary: it keeps Settings reading off
    // after a disconnect where Chrome kept the optional HTTPS permission.
    await chrome.storage.local.remove(["token", "bindings", "pairing", "siteAnchors", "editPolicies", "editPolicyRevisions", "firstCourseRead", COURSE_FILE_STORAGE_ACCESS_KEY]);
    // usedEffectReceiptFloorAt stays: it only rises, and clearing it would accept a change prepared
    // before this disconnect a second time.
    await discoveryArea().remove(["courseDiscoveries", "usedEffectReceipts"]);
  });
  const permissions = await chrome.permissions.getAll();
  const optionalOrigins = (permissions.origins || []).filter((origin) => origin.startsWith("https://"));
  let permissionsRevoked = true;
  if (optionalOrigins.length > 0) {
    try {
      permissionsRevoked = await chrome.permissions.remove({ origins: optionalOrigins });
    } catch {
      permissionsRevoked = false;
    }
  }
  return { disconnected: true, permissionsRevoked };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const settingsAction = message?.type === "morrow_edit_policy_status" ? editPolicyStatus
    : message?.type === "morrow_edit_policy_options" ? () => editPolicyOptions(message.sourceBindingId)
      : message?.type === "morrow_edit_policy_save" ? () => saveEditPolicy(message.sourceBindingId, message.enabledCategories, message.expiresInMs)
        : message?.type === "morrow_edit_policy_revoke" ? () => revokeEditPolicy(message.sourceBindingId)
          : message?.type === "morrow_course_discovery_start" ? () => startCourseDiscovery(message.siteAnchorId)
            : message?.type === "morrow_course_discovery_more" ? () => continueCourseDiscovery(message.siteAnchorId, message.discoveryReceiptId)
              : message?.type === "morrow_course_selection_save" ? () => saveCourseSelection(message.siteAnchorId, message.discoveryReceiptId, message.courseIds)
        : null;
  if (settingsAction) {
    if (!settingsSender(sender)) {
      const code = String(message?.type || "").startsWith("morrow_course_") ? "course_discovery_sender_refused" : "edit_policy_sender_refused";
      sendResponse({ ok: false, code, error: code });
      return false;
    }
    Promise.resolve(settingsAction()).then((result) => sendResponse({ ok: true, result }), (error) => {
      const code = policyCode(error);
      sendResponse({ ok: false, code, error: code });
    });
    return true;
  }
  const run = message?.type === "morrow_pair" ? requestPairing
    : message?.type === "morrow_open_setup" ? openSetupGuide
      : message?.type === "morrow_connect_course_prepare" ? () => prepareCourseConnection(message.tabId)
      : message?.type === "morrow_connect_course_complete" ? () => completePreparedCourseConnection({ intentId: message.intentId, popupConfirmed: true })
      : message?.type === "morrow_connect_course_cancel" ? () => cancelPreparedCourseConnection(message.intentId)
      : message?.type === "morrow_connect_course" ? () => connectCourseTab(message.tabId)
      : message?.type === "morrow_status" ? status
        : message?.type === "morrow_disconnect" ? disconnectConnector
        : null;
  if (!run) return false;
  Promise.resolve(run()).then((result) => sendResponse({ ok: true, result }), (error) => {
    const code = messageCode(error);
    sendResponse({ ok: false, code, error: code });
  });
  return true;
});
chrome.permissions.onAdded.addListener((permissions) => { void completePreparedCourseConnection({ addedOrigins: permissions.origins, openCourseSelection: true }).catch(() => {}); });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "morrow-pairing") void pollPairing(); });
chrome.tabs.onRemoved.addListener((tabId) => { void canvasTabChanged(tabId); });
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url) void canvasTabChanged(tabId);
  if (change.status !== "complete" || !tab.url?.startsWith(httpUrl("/pair/"))) return;
  void storage().then(({ pairing }) => {
    if (pairing?.approvalUrl === tab.url) return pollPairing();
  });
});
chrome.runtime.onStartup.addListener(() => { void pollPairing(); void connectBridge(); });
chrome.runtime.onInstalled.addListener((details) => {
  void connectBridge();
  if (shouldOpenSetupOnInstall(details)) void openSetupGuide().catch(() => {});
});
void pollPairing();
void connectBridge();
