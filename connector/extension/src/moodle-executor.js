export async function executeMoodleInPage(input) {
  try { input = JSON.parse(input); } catch { return { ok: false, sent: false, error: "moodle_arguments_invalid" }; }
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_ITEMS = 100;
  // The bridge carries one 2 MiB command, so a staged file stays at 1 MiB raw and a staged
  // set stays at 1 MiB in total. docs/implementation/MOODLE-FULL-FUNCTIONALITY.md records the
  // same transport limit. Native course and area limits can be lower and are checked as well.
  const MAX_STAGED_FILE_BYTES = 1024 * 1024;
  const MAX_STAGED_FILES = 8;
  const MAX_DISCOVERY_OFFSET = 10_000;
  const PROVIDER = "moodle";
  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const id = (value) => Number.isSafeInteger(value) && value > 0 ? String(value) : /^[1-9][0-9]*$/.test(String(value || "")) ? String(value) : "";
  const sectionNumber = (value) => Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
  const error = (code, extra = {}) => ({ ok: false, sent: false, error: code, ...extra });
  const definitions = Object.freeze({
    "moodle.ajax.core_course_get_enrolled_courses_by_timeline_classification.v1": { toolName: "moodle_list_my_courses", readOnly: true, kind: "list-courses" },
    "moodle.form.course.edit.read.v1": { toolName: "moodle_get_course", readOnly: true, kind: "course-form-read" },
    "moodle.ajax.core_courseformat_get_state.v1": { toolName: "moodle_get_contents", readOnly: true, kind: "structure" },
    "moodle.ajax.core_courseformat_get_state.assignments.v1": { toolName: "moodle_list_assignments", readOnly: true, kind: "assignments" },
    "moodle.ajax.core_courseformat_get_state.quizzes.v1": { toolName: "moodle_list_quizzes", readOnly: true, kind: "quizzes" },
    "moodle.form.mod.quiz.edit.read.v1": { toolName: "moodle_list_quiz_questions", readOnly: true, kind: "quiz-questions-read" },
    "moodle.form.question.bank.editquestion.read.v1": { toolName: "moodle_get_quiz_question", readOnly: true, kind: "quiz-question-read" },
    "moodle.form.question.bank.filter.inventory.read.v1": { toolName: "moodle_get_question_bank_filter_inventory", readOnly: true, kind: "qbank-filter-inventory-read" },
    "moodle.form.course.edit.summary.read.v1": { toolName: "moodle_get_course_summary", readOnly: true, kind: "course-form-read" },
    "moodle.form.course.editsection.read.v1": { toolName: "moodle_get_section", readOnly: true, kind: "section-form-read" },
    "moodle.form.course.modedit.page.read.v1": { toolName: "moodle_get_page", readOnly: true, kind: "page-form-read" },
    "moodle.form.course.modedit.label.read.v1": { toolName: "moodle_get_label", readOnly: true, kind: "label-form-read" },
    "moodle.form.course.modedit.label.create.read.v1": { toolName: "moodle_get_label_creation_form", readOnly: true, kind: "label-create-form-read" },
    "moodle.form.course.modedit.url.read.v1": { toolName: "moodle_get_url", readOnly: true, kind: "url-form-read" },
    "moodle.form.course.modedit.url.create.read.v1": { toolName: "moodle_get_url_creation_form", readOnly: true, kind: "url-create-form-read" },
    "moodle.form.course.modedit.forum.read.v1": { toolName: "moodle_get_forum", readOnly: true, kind: "forum-form-read" },
    "moodle.form.course.modedit.forum.create.read.v1": { toolName: "moodle_get_forum_creation_form", readOnly: true, kind: "forum-create-form-read" },
    "moodle.form.course.modedit.choice.read.v1": { toolName: "moodle_get_choice", readOnly: true, kind: "choice-form-read" },
    "moodle.form.course.modedit.choice.create.read.v1": { toolName: "moodle_get_choice_creation_form", readOnly: true, kind: "choice-create-form-read" },
    "moodle.form.course.modedit.book.read.v1": { toolName: "moodle_get_book", readOnly: true, kind: "book-form-read" },
    "moodle.form.course.modedit.book.create.read.v1": { toolName: "moodle_get_book_creation_form", readOnly: true, kind: "book-create-form-read" },
    "moodle.form.course.modedit.lesson.read.v1": { toolName: "moodle_get_lesson", readOnly: true, kind: "lesson-form-read" },
    "moodle.form.course.modedit.lesson.create.read.v1": { toolName: "moodle_get_lesson_creation_form", readOnly: true, kind: "lesson-create-form-read" },
    "moodle.form.course.modedit.glossary.read.v1": { toolName: "moodle_get_glossary", readOnly: true, kind: "glossary-form-read" },
    "moodle.form.course.modedit.glossary.create.read.v1": { toolName: "moodle_get_glossary_creation_form", readOnly: true, kind: "glossary-create-form-read" },
    "moodle.form.course.modedit.wiki.read.v1": { toolName: "moodle_get_wiki", readOnly: true, kind: "wiki-form-read" },
    "moodle.form.course.modedit.wiki.create.read.v1": { toolName: "moodle_get_wiki_creation_form", readOnly: true, kind: "wiki-create-form-read" },
    "moodle.form.course.modedit.feedback.read.v1": { toolName: "moodle_get_feedback", readOnly: true, kind: "feedback-form-read" },
    "moodle.form.course.modedit.feedback.create.read.v1": { toolName: "moodle_get_feedback_creation_form", readOnly: true, kind: "feedback-create-form-read" },
    "moodle.form.course.modedit.data.read.v1": { toolName: "moodle_get_database", readOnly: true, kind: "data-form-read" },
    "moodle.form.course.modedit.data.create.read.v1": { toolName: "moodle_get_database_creation_form", readOnly: true, kind: "data-create-form-read" },
    "moodle.form.mod.book.chapters.read.v1": { toolName: "moodle_list_book_chapters", readOnly: true, kind: "book-chapters-read" },
    "moodle.form.mod.book.chapter.read.v1": { toolName: "moodle_get_book_chapter", readOnly: true, kind: "book-chapter-read" },
    "moodle.form.mod.book.chapter.create.read.v1": { toolName: "moodle_get_book_chapter_creation_form", readOnly: true, kind: "book-chapter-create-form-read" },
    "moodle.form.course.modedit.resource.files.read.v1": { toolName: "moodle_get_resource_files", readOnly: true, kind: "resource-files-read" },
    "moodle.form.course.modedit.resource.file.create.read.v1": { toolName: "moodle_get_resource_file_creation_form", readOnly: true, kind: "resource-file-create-form-read" },
    "moodle.form.course.modedit.folder.read.v1": { toolName: "moodle_get_folder", readOnly: true, kind: "folder-form-read" },
    "moodle.form.course.modedit.folder.files.read.v1": { toolName: "moodle_get_folder_files", readOnly: true, kind: "folder-files-read" },
    "moodle.form.course.modedit.folder.file.create.read.v1": { toolName: "moodle_get_folder_file_creation_form", readOnly: true, kind: "folder-file-create-form-read" },
    "moodle.form.course.modedit.imscp.read.v1": { toolName: "moodle_get_imscp", readOnly: true, kind: "imscp-form-read" },
    "moodle.form.course.modedit.imscp.package.create.read.v1": { toolName: "moodle_get_imscp_package_creation_form", readOnly: true, kind: "imscp-package-create-form-read" },
    "moodle.form.course.modedit.scorm.read.v1": { toolName: "moodle_get_scorm", readOnly: true, kind: "scorm-form-read" },
    "moodle.form.course.modedit.scorm.package.create.read.v1": { toolName: "moodle_get_scorm_package_creation_form", readOnly: true, kind: "scorm-package-create-form-read" },
    "moodle.form.course.modedit.page.create.read.v1": { toolName: "moodle_get_page_creation_form", readOnly: true, kind: "page-create-form-read" },
    "moodle.form.course.modedit.assign.read.v1": { toolName: "moodle_get_assignment", readOnly: true, kind: "assignment-form-read" },
    "moodle.form.course.modedit.quiz.read.v1": { toolName: "moodle_get_quiz", readOnly: true, kind: "quiz-form-read" },
    "moodle.form.course.modedit.assign.create.read.v1": { toolName: "moodle_get_assignment_creation_form", readOnly: true, kind: "assignment-create-form-read" },
    "moodle.form.mod.assign.overrides.read.v1": { toolName: "moodle_get_assignment_overrides", readOnly: true, kind: "assignment-overrides-read" },
    "moodle.form.mod.quiz.overrides.read.v1": { toolName: "moodle_get_quiz_overrides", readOnly: true, kind: "quiz-overrides-read" },
    "moodle.form.course.modedit.quiz.create.read.v1": { toolName: "moodle_get_quiz_creation_form", readOnly: true, kind: "quiz-create-form-read" },
    "moodle.form.course.edit.summary.write.v1": { toolName: "moodle_update_course_summary", readOnly: false, kind: "course-form-write" },
    "moodle.form.course.editsection.write.v1": { toolName: "moodle_update_section", readOnly: false, kind: "section-form-write" },
    "moodle.form.course.modedit.page.write.v1": { toolName: "moodle_update_page", readOnly: false, kind: "page-form-write" },
    "moodle.form.course.modedit.label.write.v1": { toolName: "moodle_update_label", readOnly: false, kind: "label-form-write" },
    "moodle.form.course.modedit.label.create.write.v1": { toolName: "moodle_create_label", readOnly: false, kind: "label-create-form-write" },
    "moodle.form.course.modedit.url.write.v1": { toolName: "moodle_update_url", readOnly: false, kind: "url-form-write" },
    "moodle.form.course.modedit.url.create.write.v1": { toolName: "moodle_create_url", readOnly: false, kind: "url-create-form-write" },
    "moodle.form.course.modedit.forum.write.v1": { toolName: "moodle_update_forum", readOnly: false, kind: "forum-form-write" },
    "moodle.form.course.modedit.forum.create.write.v1": { toolName: "moodle_create_forum", readOnly: false, kind: "forum-create-form-write" },
    "moodle.form.course.modedit.choice.write.v1": { toolName: "moodle_update_choice", readOnly: false, kind: "choice-form-write" },
    "moodle.form.course.modedit.choice.create.write.v1": { toolName: "moodle_create_choice", readOnly: false, kind: "choice-create-form-write" },
    "moodle.form.course.modedit.book.write.v1": { toolName: "moodle_update_book", readOnly: false, kind: "book-form-write" },
    "moodle.form.course.modedit.book.create.write.v1": { toolName: "moodle_create_book", readOnly: false, kind: "book-create-form-write" },
    "moodle.form.course.modedit.lesson.write.v1": { toolName: "moodle_update_lesson", readOnly: false, kind: "lesson-form-write" },
    "moodle.form.course.modedit.lesson.create.write.v1": { toolName: "moodle_create_lesson", readOnly: false, kind: "lesson-create-form-write" },
    "moodle.form.course.modedit.glossary.write.v1": { toolName: "moodle_update_glossary", readOnly: false, kind: "glossary-form-write" },
    "moodle.form.course.modedit.glossary.create.write.v1": { toolName: "moodle_create_glossary", readOnly: false, kind: "glossary-create-form-write" },
    "moodle.form.course.modedit.wiki.write.v1": { toolName: "moodle_update_wiki", readOnly: false, kind: "wiki-form-write" },
    "moodle.form.course.modedit.wiki.create.write.v1": { toolName: "moodle_create_wiki", readOnly: false, kind: "wiki-create-form-write" },
    "moodle.form.course.modedit.feedback.write.v1": { toolName: "moodle_update_feedback", readOnly: false, kind: "feedback-form-write" },
    "moodle.form.course.modedit.feedback.create.write.v1": { toolName: "moodle_create_feedback", readOnly: false, kind: "feedback-create-form-write" },
    "moodle.form.course.modedit.data.write.v1": { toolName: "moodle_update_database", readOnly: false, kind: "data-form-write" },
    "moodle.form.course.modedit.data.create.write.v1": { toolName: "moodle_create_database", readOnly: false, kind: "data-create-form-write" },
    "moodle.form.mod.book.chapter.create.write.v1": { toolName: "moodle_create_book_chapter", readOnly: false, kind: "book-chapter-create-form-write" },
    "moodle.form.mod.book.chapter.write.v1": { toolName: "moodle_update_book_chapter", readOnly: false, kind: "book-chapter-form-write" },
    "moodle.form.mod.book.chapter.move.write.v1": { toolName: "moodle_move_book_chapter", readOnly: false, kind: "book-chapter-move" },
    "moodle.form.mod.book.chapter.show.write.v1": { toolName: "moodle_show_book_chapter", readOnly: false, kind: "book-chapter-show" },
    "moodle.form.mod.book.chapter.hide.write.v1": { toolName: "moodle_hide_book_chapter", readOnly: false, kind: "book-chapter-hide" },
    "moodle.form.mod.book.chapter.delete.write.v1": { toolName: "moodle_delete_book_chapter", readOnly: false, kind: "book-chapter-delete" },
    "moodle.form.course.modedit.page.create.write.v1": { toolName: "moodle_create_page", readOnly: false, kind: "page-create-form-write" },
    "moodle.form.course.modedit.assign.write.v1": { toolName: "moodle_update_assignment", readOnly: false, kind: "assignment-form-write" },
    "moodle.form.course.modedit.quiz.write.v1": { toolName: "moodle_update_quiz", readOnly: false, kind: "quiz-form-write" },
    "moodle.form.course.modedit.assign.create.write.v1": { toolName: "moodle_create_assignment", readOnly: false, kind: "assignment-create-form-write" },
    "moodle.form.mod.assign.override.create.write.v1": { toolName: "moodle_create_assignment_override", readOnly: false, kind: "assignment-override-create" },
    "moodle.form.mod.assign.override.write.v1": { toolName: "moodle_update_assignment_override", readOnly: false, kind: "assignment-override-write" },
    "moodle.form.mod.quiz.override.create.write.v1": { toolName: "moodle_create_quiz_override", readOnly: false, kind: "quiz-override-create" },
    "moodle.form.mod.quiz.override.write.v1": { toolName: "moodle_update_quiz_override", readOnly: false, kind: "quiz-override-write" },
    "moodle.form.course.modedit.quiz.create.write.v1": { toolName: "moodle_create_quiz", readOnly: false, kind: "quiz-create-form-write" },
    "moodle.form.course.modedit.resource.file.create.write.v1": { toolName: "moodle_create_resource_file", readOnly: false, kind: "resource-file-create-form-write" },
    "moodle.form.course.modedit.folder.file.create.write.v1": { toolName: "moodle_create_folder_file", readOnly: false, kind: "folder-file-create-form-write" },
    "moodle.form.course.modedit.resource.file.replace.write.v1": { toolName: "moodle_replace_resource_file", readOnly: false, kind: "resource-file-replace" },
    "moodle.form.course.modedit.resource.file.delete.write.v1": { toolName: "moodle_delete_resource_file", readOnly: false, kind: "resource-file-delete" },
    "moodle.form.course.modedit.folder.files.add.write.v1": { toolName: "moodle_add_folder_files", readOnly: false, kind: "folder-files-add" },
    "moodle.form.course.modedit.folder.subfolder.create.write.v1": { toolName: "moodle_create_folder_subfolder", readOnly: false, kind: "folder-subfolder-create" },
    "moodle.form.course.modedit.imscp.package.create.write.v1": { toolName: "moodle_create_imscp_package", readOnly: false, kind: "imscp-package-create-form-write" },
    "moodle.form.course.modedit.scorm.package.create.write.v1": { toolName: "moodle_create_scorm_package", readOnly: false, kind: "scorm-package-create-form-write" },
    "moodle.form.mod.quiz.question.multichoice.create.write.v1": { toolName: "moodle_create_quiz_multichoice_question", readOnly: false, kind: "quiz-question-create-form-write", qtype: "multichoice" },
    "moodle.form.mod.quiz.question.truefalse.create.write.v1": { toolName: "moodle_create_quiz_truefalse_question", readOnly: false, kind: "quiz-question-create-form-write", qtype: "truefalse" },
    "moodle.form.mod.quiz.question.shortanswer.create.write.v1": { toolName: "moodle_create_quiz_shortanswer_question", readOnly: false, kind: "quiz-question-create-form-write", qtype: "shortanswer" },
    "moodle.form.mod.quiz.question.numerical.create.write.v1": { toolName: "moodle_create_quiz_numerical_question", readOnly: false, kind: "quiz-question-create-form-write", qtype: "numerical" },
    "moodle.form.mod.quiz.question.essay.create.write.v1": { toolName: "moodle_create_quiz_essay_question", readOnly: false, kind: "quiz-question-create-form-write", qtype: "essay" },
    "moodle.form.mod.quiz.question.match.create.write.v1": { toolName: "moodle_create_quiz_matching_question", readOnly: false, kind: "quiz-question-create-form-write", qtype: "match" },
    "moodle.form.mod.quiz.question.description.create.write.v1": { toolName: "moodle_create_quiz_description_question", readOnly: false, kind: "quiz-question-create-form-write", qtype: "description" },
    "moodle.form.mod.quiz.question.gapselect.create.write.v1": { toolName: "moodle_create_quiz_gapselect_question", readOnly: false, kind: "quiz-question-create-form-write", qtype: "gapselect" },
    "moodle.form.mod.quiz.question.ddwtos.create.write.v1": { toolName: "moodle_create_quiz_ddwtos_question", readOnly: false, kind: "quiz-question-create-form-write", qtype: "ddwtos" },
    "moodle.form.mod.quiz.question.multianswer.create.write.v1": { toolName: "moodle_create_quiz_multianswer_question", readOnly: false, kind: "quiz-question-create-form-write", qtype: "multianswer" },
    "moodle.form.question.bank.editquestion.truefalse.write.v1": { toolName: "moodle_update_quiz_truefalse_question", readOnly: false, kind: "quiz-question-write", qtype: "truefalse" },
    "moodle.form.question.bank.editquestion.shortanswer.write.v1": { toolName: "moodle_update_quiz_shortanswer_question", readOnly: false, kind: "quiz-question-write", qtype: "shortanswer" },
    "moodle.form.question.bank.editquestion.numerical.write.v1": { toolName: "moodle_update_quiz_numerical_question", readOnly: false, kind: "quiz-question-write", qtype: "numerical" },
    "moodle.form.question.bank.editquestion.essay.write.v1": { toolName: "moodle_update_quiz_essay_question", readOnly: false, kind: "quiz-question-write", qtype: "essay" },
    "moodle.form.question.bank.editquestion.match.write.v1": { toolName: "moodle_update_quiz_matching_question", readOnly: false, kind: "quiz-question-write", qtype: "match" },
    "moodle.form.question.bank.editquestion.description.write.v1": { toolName: "moodle_update_quiz_description_question", readOnly: false, kind: "quiz-question-write", qtype: "description" },
    "moodle.form.question.bank.editquestion.gapselect.write.v1": { toolName: "moodle_update_quiz_gapselect_question", readOnly: false, kind: "quiz-question-write", qtype: "gapselect" },
    "moodle.form.question.bank.editquestion.ddwtos.write.v1": { toolName: "moodle_update_quiz_ddwtos_question", readOnly: false, kind: "quiz-question-write", qtype: "ddwtos" },
    "moodle.form.question.bank.editquestion.multianswer.write.v1": { toolName: "moodle_update_quiz_multianswer_question", readOnly: false, kind: "quiz-question-write", qtype: "multianswer" },
    "moodle.form.course.edit.visibility.write.v1": { toolName: "moodle_show_course", readOnly: false, kind: "course-show" },
    "moodle.form.course.edit.visibility.hide.v1": { toolName: "moodle_hide_course", readOnly: false, kind: "course-hide" },
    "moodle.ajax.core_courseformat_update_course.section_show.v1": { toolName: "moodle_show_section", readOnly: false, kind: "section-show" },
    "moodle.ajax.core_courseformat_update_course.section_hide.v1": { toolName: "moodle_hide_section", readOnly: false, kind: "section-hide" },
    "moodle.ajax.core_courseformat_update_course.cm_show.v1": { toolName: "moodle_show_activity", readOnly: false, kind: "activity-show" },
    "moodle.ajax.core_courseformat_update_course.cm_hide.v1": { toolName: "moodle_hide_activity", readOnly: false, kind: "activity-hide" },
    "moodle.ajax.core_courseformat_update_course.cm_move.v1": { toolName: "moodle_move_activity", readOnly: false, kind: "activity-move" },
  });
  const supportedQuestionTypes = new Set(["multichoice", "truefalse", "shortanswer", "numerical", "essay", "match", "ordering", "randomsamatch", "description", "gapselect", "ddwtos", "ddimageortext", "ddmarker", "multianswer", "calculated", "calculatedmulti", "calculatedsimple"]);
  const creationSpec = Object.freeze({
    page: { module: "page", type: "page-create", body: "page[text]", dataBody: "content", dates: [] },
    label: { module: "label", type: "label-create", body: "introeditor[text]", dataBody: "content", dates: [], submitName: "submitbutton2", strictIdentity: true, readKind: "label-form-read", stateResolved: true },
    url: { module: "url", type: "url-create", body: "introeditor[text]", dataBody: "description", fields: [{ argument: "external_url", field: "externalurl" }], dates: [], strictIdentity: true, readKind: "url-form-read" },
    forum: { module: "forum", type: "forum-create", body: "introeditor[text]", dataBody: "instructions", dates: [{ argument: "due_date", field: "duedate" }, { argument: "cutoff_at", field: "cutoffdate" }], readKind: "forum-form-read" },
    choice: { module: "choice", type: "choice-create", body: "introeditor[text]", dataBody: "instructions", dates: [{ argument: "open_at", field: "timeopen" }, { argument: "close_at", field: "timeclose" }], readKind: "choice-form-read" },
    book: { module: "book", type: "book-create", body: "introeditor[text]", dataBody: "instructions", fields: [{ argument: "numbering", field: "numbering" }, { argument: "custom_titles", field: "customtitles" }], dates: [], readKind: "book-form-read" },
    lesson: { module: "lesson", type: "lesson-create", body: "introeditor[text]", dataBody: "instructions", dates: [{ argument: "available_from", field: "available" }, { argument: "deadline", field: "deadline" }], readKind: "lesson-form-read" },
    glossary: { module: "glossary", type: "glossary-create", body: "introeditor[text]", dataBody: "instructions", fields: [{ argument: "default_approval", field: "defaultapproval", kind: "boolean" }, { argument: "allow_comments", field: "allowcomments", kind: "boolean" }], dates: [], readKind: "glossary-form-read" },
    wiki: { module: "wiki", type: "wiki-create", body: "introeditor[text]", dataBody: "instructions", fields: [{ argument: "wiki_mode", field: "wikimode", kind: "select" }, { argument: "first_page_title", field: "firstpagetitle", kind: "text" }, { argument: "default_format", field: "defaultformat", kind: "select" }, { argument: "force_format", field: "forceformat", kind: "boolean" }], dates: [], readKind: "wiki-form-read" },
    feedback: { module: "feedback", type: "feedback-create", body: "introeditor[text]", dataBody: "instructions", fields: [{ argument: "anonymous", field: "anonymous", kind: "select" }], dates: [{ argument: "open_at", field: "timeopen" }, { argument: "close_at", field: "timeclose" }], readKind: "feedback-form-read" },
    data: { module: "data", type: "data-create", body: "introeditor[text]", dataBody: "instructions", fields: [{ argument: "approval", field: "approval", kind: "boolean" }], dates: [{ argument: "available_from", field: "timeavailablefrom" }, { argument: "available_to", field: "timeavailableto" }], readKind: "data-form-read" },
    assign: { module: "assign", type: "assignment-create", body: "introeditor[text]", dataBody: "instructions", dates: [{ argument: "available_from", field: "allowsubmissionsfromdate" }, { argument: "due_date", field: "duedate" }, { argument: "cutoff_at", field: "cutoffdate" }, { argument: "grading_due_at", field: "gradingduedate" }] },
    quiz: { module: "quiz", type: "quiz-create", body: "introeditor[text]", dataBody: "instructions", dates: [{ argument: "open_at", field: "timeopen" }, { argument: "close_at", field: "timeclose" }], requiresSebOff: true },
  });
  const creationModule = (kind) => Object.entries(creationSpec).find(([, spec]) => kind.startsWith(spec.type))?.[0] || "";
  // Every non-date control of the native Assignment form that Morrow can write,
  // in the order mod_form.php declares them. A control that is absent from the
  // loaded form, because the site disabled that submission or feedback plugin,
  // is read as empty and refused for a write.
  const assignmentSettings = Object.freeze([
    { argument: "always_show_description", field: "alwaysshowdescription", kind: "boolean" },
    { argument: "online_text", field: "assignsubmission_onlinetext_enabled", kind: "boolean" },
    { argument: "online_text_word_limit", field: "assignsubmission_onlinetext_wordlimit", kind: "count", enabledField: "assignsubmission_onlinetext_wordlimit_enabled" },
    { argument: "file_submissions", field: "assignsubmission_file_enabled", kind: "boolean" },
    { argument: "maximum_files", field: "assignsubmission_file_maxfiles", kind: "select", available: "available_maximum_files" },
    { argument: "maximum_submission_size", field: "assignsubmission_file_maxsizebytes", kind: "select", available: "available_submission_sizes" },
    { argument: "accepted_file_types", field: "assignsubmission_file_filetypes", kind: "text" },
    { argument: "feedback_comments", field: "assignfeedback_comments_enabled", kind: "boolean" },
    { argument: "comment_inline", field: "assignfeedback_comments_commentinline", kind: "boolean" },
    { argument: "feedback_files", field: "assignfeedback_file_enabled", kind: "boolean" },
    { argument: "offline_grading_worksheet", field: "assignfeedback_offline_enabled", kind: "boolean" },
    { argument: "annotate_pdf", field: "assignfeedback_editpdf_enabled", kind: "boolean" },
    { argument: "require_click_submit", field: "submissiondrafts", kind: "boolean" },
    { argument: "require_submission_statement", field: "requiresubmissionstatement", kind: "boolean" },
    { argument: "additional_attempts", field: "attemptreopenmethod", kind: "select", available: "available_additional_attempts" },
    { argument: "maximum_attempts", field: "maxattempts", kind: "select", available: "available_maximum_attempts" },
    { argument: "group_submission", field: "teamsubmission", kind: "boolean" },
    { argument: "require_group_membership", field: "preventsubmissionnotgroup", kind: "boolean" },
    { argument: "require_all_members_submit", field: "requireallteammemberssubmit", kind: "boolean" },
    { argument: "grouping_id", field: "teamsubmissiongroupingid", kind: "select", available: "available_groupings" },
    { argument: "notify_graders", field: "sendnotifications", kind: "boolean" },
    { argument: "notify_graders_late", field: "sendlatenotifications", kind: "boolean" },
    { argument: "notify_students_default", field: "sendstudentnotifications", kind: "boolean" },
    { argument: "grade_category", field: "gradecat", kind: "select", available: "available_grade_categories" },
    { argument: "blind_marking", field: "blindmarking", kind: "boolean" },
    { argument: "marking_workflow", field: "markingworkflow", kind: "boolean" },
  ]);
  // Moodle freezes blind marking once the Assignment has submissions or grades,
  // so the frozen control is the form's own statement that they exist.
  const assignmentSubmissionArguments = Object.freeze(["blind_marking", "marking_workflow"]);
  const assignmentDateFields = Object.freeze([
    { argument: "available_from", field: "allowsubmissionsfromdate" },
    { argument: "due_date", field: "duedate" },
    { argument: "cutoff_at", field: "cutoffdate" },
    { argument: "grading_due_at", field: "gradingduedate" },
  ]);
  const quizDateFields = Object.freeze([
    { argument: "open_at", field: "timeopen" },
    { argument: "close_at", field: "timeclose" },
  ]);
  // Every non-date, non-matrix control of the native Quiz form that Morrow can
  // write, in the order mod_form.php declares them. A control that is absent
  // from the loaded form, because the site or the site policy removed it, is
  // read as null and refused for a write. A duration is expressed in seconds.
  const quizSettings = Object.freeze([
    { argument: "time_limit_seconds", field: "timelimit", kind: "duration" },
    { argument: "when_time_expires", field: "overduehandling", kind: "select", available: "available_overdue_handling" },
    { argument: "grace_period_seconds", field: "graceperiod", kind: "duration" },
    { argument: "grade_category", field: "gradecat", kind: "select", available: "available_grade_categories" },
    { argument: "attempts_allowed", field: "attempts", kind: "select", available: "available_attempts_allowed" },
    { argument: "grading_method", field: "grademethod", kind: "select", available: "available_grading_methods" },
    { argument: "new_page", field: "questionsperpage", kind: "select", available: "available_new_page_options" },
    { argument: "navigation_method", field: "navmethod", kind: "select", available: "available_navigation_methods" },
    { argument: "shuffle_within_questions", field: "shuffleanswers", kind: "boolean" },
    { argument: "how_questions_behave", field: "preferredbehaviour", kind: "select", available: "available_question_behaviours" },
    { argument: "each_attempt_builds_on_last", field: "attemptonlast", kind: "boolean" },
    { argument: "show_user_picture", field: "showuserpicture", kind: "select", available: "available_user_picture_modes" },
    { argument: "decimal_places_in_grades", field: "decimalpoints", kind: "select", available: "available_grade_decimal_places" },
    { argument: "decimal_places_in_question_grades", field: "questiondecimalpoints", kind: "select", available: "available_question_decimal_places" },
    { argument: "show_blocks", field: "showblocks", kind: "boolean" },
    { argument: "network_address", field: "subnet", kind: "text" },
    { argument: "delay_between_first_and_second_seconds", field: "delay1", kind: "duration" },
    { argument: "delay_between_later_attempts_seconds", field: "delay2", kind: "duration" },
    { argument: "browser_security", field: "browsersecurity", kind: "select", available: "available_browser_security_modes" },
  ]);
  // The native review-options matrix: eight rows by four columns of checkboxes
  // named <field><when>.
  const quizReviewFields = Object.freeze([
    { argument: "attempt", field: "attempt" },
    { argument: "correctness", field: "correctness" },
    { argument: "maximum_marks", field: "maxmarks" },
    { argument: "marks", field: "marks" },
    { argument: "specific_feedback", field: "specificfeedback" },
    { argument: "general_feedback", field: "generalfeedback" },
    { argument: "right_answer", field: "rightanswer" },
    { argument: "overall_feedback", field: "overallfeedback" },
  ]);
  const quizReviewWhens = Object.freeze(["during", "immediately", "open", "closed"]);
  // quiz_process_options always adds the attempt to the during-the-attempt
  // review and always removes overall feedback from it, so neither cell can
  // hold any other value.
  const quizFixedReviewOptions = Object.freeze([
    { argument: "attempt", when: "during", value: true },
    { argument: "overall_feedback", when: "during", value: false },
  ]);
  const QUIZ_FEEDBACK_LIMIT = 50;
  const MAX_DURATION_SECONDS = 365 * 24 * 60 * 60;
  // The native override pages of one module. The list route is fixed, every
  // override edit route is the same page with the exact override ID, and the
  // route that adds an override is taken from the list page itself, because
  // only the page states how Moodle spells that action for this site.
  const overrideSpec = Object.freeze({
    assign: Object.freeze({
      module: "assign", type: "assign-override", label: "Assignment", noun: "assignment",
      formIdentity: "_qf__assign_override_form",
      fields: Object.freeze([
        { argument: "available_from", field: "allowsubmissionsfromdate", kind: "date" },
        { argument: "due_date", field: "duedate", kind: "date" },
        { argument: "cutoff_at", field: "cutoffdate", kind: "date" },
      ]),
    }),
    quiz: Object.freeze({
      module: "quiz", type: "quiz-override", label: "Quiz", noun: "quiz",
      formIdentity: "_qf__mod_quiz_form_edit_override_form",
      fields: Object.freeze([
        { argument: "open_at", field: "timeopen", kind: "date" },
        { argument: "close_at", field: "timeclose", kind: "date" },
        { argument: "time_limit_seconds", field: "timelimit", kind: "duration" },
        { argument: "attempts_allowed", field: "attempts", kind: "select" },
      ]),
    }),
  });
  const overrideModule = (kind) => kind.startsWith("quiz-override") || kind === "quiz-overrides-read" ? "quiz" : "assign";
  const OVERRIDE_LIMIT = 25;
  const transientField = (name) => /(?:sesskey|statekey|_qf__|csrf|token|secret|password|authorization|cookie|(?:^|[\[_-])(?:draft|itemid)(?:$|[\]_-]))/i.test(name);
  const redact = (value) => value.replace(/([?&](?:sesskey|token|csrf|password|secret)=)[^&#\s]+/gi, "$1[redacted]");
  const sanitize = (value, depth = 0) => {
    if (depth > 24) return null;
    if (Array.isArray(value)) return value.slice(0, 10_000).map((entry) => sanitize(entry, depth + 1));
    if (!isObject(value)) return typeof value === "string" ? redact(value.slice(0, MAX_BYTES)) : value;
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      if (transientField(key)) continue;
      output[key] = sanitize(child, depth + 1);
    }
    return output;
  };
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value === undefined ? null : value);
  };
  const digest = async (value) => {
    if (!globalThis.crypto?.subtle) throw new Error("digest unavailable");
    const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value)));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const currentContext = () => {
    const cfg = globalThis.M?.cfg;
    if (!isObject(cfg) || typeof cfg.wwwroot !== "string" || !cfg.wwwroot || typeof cfg.sesskey !== "string" || !cfg.sesskey) return null;
    const principalId = id(cfg.userId);
    if (!principalId) return null;
    let parsed;
    try { parsed = new URL(cfg.wwwroot); } catch { return null; }
    if (parsed.protocol !== "https:" || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
    const currentOrigin = String(globalThis.location?.origin || "");
    const currentPath = String(globalThis.location?.pathname || "");
    const basePath = parsed.pathname.replace(/\/$/, "");
    if (currentOrigin !== parsed.origin || !(currentPath === basePath || currentPath.startsWith(`${basePath}/`))) return null;
    const cfgCourse = id(cfg.courseId);
    const bodyCourse = String(globalThis.document?.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
    if (cfgCourse && bodyCourse && cfgCourse !== bodyCourse) return null;
    const courseId = cfgCourse || bodyCourse || "";
    const courseNames = new Set();
    const addCourseName = (value) => { const name = String(value || "").trim().replace(/\s+/g, " "); if (name && name.length <= 500) courseNames.add(name); };
    if (courseId) {
      const coursePath = `${basePath}/course/view.php`;
      if (currentPath === coursePath && new URL(globalThis.location.href).searchParams.get("id") === courseId) {
        addCourseName(globalThis.document?.querySelector?.("h1")?.textContent);
      } else {
        for (const anchor of globalThis.document?.querySelectorAll?.("#page-navbar .breadcrumb a[href]") || []) {
          let href;
          try { href = new URL(anchor.getAttribute("href"), parsed.href); } catch { continue; }
          if (href.origin === parsed.origin && href.pathname === coursePath && href.searchParams.get("id") === courseId) addCourseName(anchor.textContent);
        }
      }
    }
    const courseName = courseNames.size === 1 ? [...courseNames][0] : "";
    return {
      profile: {
        provider: PROVIDER,
        origin: parsed.origin,
        siteUrl: parsed.href,
        principalId,
        ...(courseId ? { courseId } : {}),
        ...(courseName && courseName.length <= 500 ? { courseName } : {}),
      },
      sesskey: cfg.sesskey,
      basePath,
    };
  };
  const sameContext = (left, right) => left?.profile?.origin === right?.profile?.origin
    && left?.profile?.siteUrl === right?.profile?.siteUrl
    && left?.profile?.principalId === right?.profile?.principalId
    && (left?.profile?.courseId || "") === (right?.profile?.courseId || "")
    && left?.sesskey === right?.sesskey;
  const urlFor = (context, path, params = {}) => {
    const root = new URL(context.profile.siteUrl);
    root.pathname = `${context.basePath}${path}` || path;
    root.search = new URLSearchParams(params).toString();
    root.hash = "";
    return root.toString();
  };
  const validateBinding = (context, binding) => {
    if (!isObject(binding) || binding.origin !== context.profile.origin || binding.siteUrl !== context.profile.siteUrl
      || String(binding.principalId || "") !== context.profile.principalId) return "moodle_binding_mismatch";
    if (binding.courseId !== undefined) {
      const boundCourse = id(binding.courseId);
      if (!boundCourse) return "moodle_course_mismatch";
    }
    return "";
  };
  const expectedOperation = (operation) => {
    if (!isObject(operation) || typeof operation.key !== "string") return null;
    const definition = definitions[operation.key];
    if (!definition || operation.toolName !== definition.toolName || operation.provider !== PROVIDER || operation.readOnly !== definition.readOnly) return null;
    return definition;
  };
  const courseArgument = (argumentsValue, binding, context) => {
    const courseId = id(argumentsValue.course_id);
    if (!courseId || (binding.courseId !== undefined && courseId !== id(binding.courseId))) return "";
    return courseId;
  };
  const validString = (value, maximum) => typeof value === "string" && value.length <= maximum && !value.includes("\u0000");
  const nativeUrlValue = (value) => {
    const textarea = globalThis.document?.createElement?.("textarea");
    if (!textarea) return "";
    textarea.innerHTML = String(value).trim().replace(/<\/textarea/gi, "&lt;/textarea");
    const decoded = textarea.value;
    return /^(?:[a-z]+:|\/)/i.test(decoded) ? decoded : `http://${decoded}`;
  };
  const webUrlValue = (value) => {
    const normalized = nativeUrlValue(value);
    if (/^(?:javascript|data|vbscript):/i.test(normalized)) return "";
    return /^(?:https?|ftp):\/\//i.test(normalized) || normalized.startsWith("/") ? normalized : "";
  };
  const validDate = (value) => {
    if (!isObject(value) || Object.keys(value).length !== 5 || !["year", "month", "day", "hour", "minute"].every((key) => Number.isSafeInteger(value[key]))) return false;
    const { year, month, day, hour, minute } = value;
    if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  };
  const validNullableDate = (value) => value === null || validDate(value);
  const compareDate = (left, right) => Date.UTC(left.year, left.month - 1, left.day, left.hour, left.minute) - Date.UTC(right.year, right.month - 1, right.day, right.hour, right.minute);
  const validMoodleSelectValue = (value) => validString(value, 64) && Boolean(value);
  const validBoolean = (value) => typeof value === "boolean";
  const validForumAssessment = (value) => isObject(value) && ((only(value, ["type"]) && value.type === "none")
    || (only(value, ["type", "maximum_points"]) && value.type === "point" && Number.isSafeInteger(value.maximum_points) && value.maximum_points > 0 && value.maximum_points <= 1000000));
  const validAssignmentGrade = (value) => isObject(value) && ((only(value, ["type"]) && value.type === "none")
    || (only(value, ["type", "maximum_points"]) && value.type === "point" && Number.isSafeInteger(value.maximum_points) && value.maximum_points > 0 && value.maximum_points <= 1000000)
    || (only(value, ["type", "scale"]) && value.type === "scale" && validMoodleSelectValue(value.scale)));
  const validAssignmentSetting = (setting, value) => setting.kind === "boolean" ? validBoolean(value)
    : setting.kind === "select" ? validMoodleSelectValue(value)
      : setting.kind === "count" ? value === null || (Number.isSafeInteger(value) && value > 0 && value <= 1000000)
        : validString(value, 255) && /^[A-Za-z0-9 ,.\-_/+*]*$/.test(value);
  const assignmentDatesOrdered = (value) => {
    const at = (name) => (value[name] === undefined || value[name] === null ? null : value[name]);
    const availableFrom = at("available_from");
    const dueDate = at("due_date");
    const cutoffAt = at("cutoff_at");
    const gradingDueAt = at("grading_due_at");
    return (!availableFrom || !dueDate || compareDate(dueDate, availableFrom) > 0)
      && (!cutoffAt || !dueDate || compareDate(cutoffAt, dueDate) >= 0)
      && (!cutoffAt || !availableFrom || compareDate(cutoffAt, availableFrom) >= 0)
      && (!gradingDueAt || !availableFrom || compareDate(gradingDueAt, availableFrom) >= 0)
      && (!gradingDueAt || !dueDate || compareDate(gradingDueAt, dueDate) >= 0);
  };
  const validQuizDuration = (value) => value === null || (Number.isSafeInteger(value) && value > 0 && value <= MAX_DURATION_SECONDS);
  const validQuizSetting = (setting, value) => setting.kind === "boolean" ? validBoolean(value)
    : setting.kind === "select" ? validMoodleSelectValue(value)
      : setting.kind === "duration" ? validQuizDuration(value)
        : validString(value, 255) && /^[0-9A-Fa-f ,.:/-]*$/.test(value);
  const validQuizReviewOptions = (value) => isObject(value)
    && Object.keys(value).length === quizReviewFields.length
    && only(value, quizReviewFields.map(({ argument }) => argument))
    && quizReviewFields.every(({ argument }) => isObject(value[argument])
      && Object.keys(value[argument]).length === quizReviewWhens.length
      && only(value[argument], [...quizReviewWhens])
      && quizReviewWhens.every((when) => validBoolean(value[argument][when])));
  const validQuizBoundary = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000000;
  const validQuizFeedbackBands = (value) => Array.isArray(value) && value.length <= QUIZ_FEEDBACK_LIMIT
    && value.every((band, index) => isObject(band) && only(band, ["feedback", "lower_boundary"])
      && validString(band.feedback, 40000) && Boolean(band.feedback) && !hasEmbeddedFile(band.feedback)
      && (index === value.length - 1 ? band.lower_boundary === null : validQuizBoundary(band.lower_boundary)));
  const validOverrideField = (field, value) => field.kind === "date" ? validNullableDate(value)
    : field.kind === "duration" ? validQuizDuration(value) : validMoodleSelectValue(value);
  const validChoiceOptions = (value) => Array.isArray(value) && value.length >= 1 && value.length <= MAX_ITEMS
    && value.every((option) => validString(option, 40000) && Boolean(option) && !hasEmbeddedFile(option));
  const validChoiceLimits = (value, options, limitAnswers) => Array.isArray(value) && value.length === options.length
    && value.every((limit) => Number.isSafeInteger(limit) && limit >= (limitAnswers ? 1 : 0) && limit <= 1000000)
    && (limitAnswers || value.every((limit) => limit === 0));
  const creationDatesValid = (module, value) => {
    const spec = creationSpec[module];
    if (!spec || !spec.dates.every(({ argument }) => validNullableDate(value[argument]))) return false;
    if (module === "assign") {
      const { available_from: availableFrom, due_date: dueDate, cutoff_at: cutoffAt, grading_due_at: gradingDueAt } = value;
      return (!availableFrom || !dueDate || compareDate(dueDate, availableFrom) > 0)
        && (!cutoffAt || !dueDate || compareDate(cutoffAt, dueDate) >= 0)
        && (!cutoffAt || !availableFrom || compareDate(cutoffAt, availableFrom) >= 0)
        && (!gradingDueAt || !availableFrom || compareDate(gradingDueAt, availableFrom) >= 0)
        && (!gradingDueAt || !dueDate || compareDate(gradingDueAt, dueDate) >= 0);
    }
    if (module === "forum") return !value.due_date || !value.cutoff_at || compareDate(value.cutoff_at, value.due_date) >= 0;
    if (module === "lesson") return !value.available_from || !value.deadline || compareDate(value.deadline, value.available_from) >= 0;
    if (module === "feedback") return !value.open_at || !value.close_at || compareDate(value.close_at, value.open_at) >= 0;
    if (module === "data") return !value.available_from || !value.available_to || compareDate(value.available_to, value.available_from) >= 0;
    return !["quiz", "choice"].includes(module) || !value.open_at || !value.close_at || compareDate(value.close_at, value.open_at) >= 0;
  };
  const validDigest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const withoutMorrow = (value) => {
    if (!isObject(value)) return null;
    const result = { ...value };
    delete result._morrow;
    return result;
  };
  const only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
  const validStagedFileSize = (value) => Number.isSafeInteger(value) && value >= 1 && value <= MAX_STAGED_FILE_BYTES;
  const validQuestionRichText = (value, required = false) => validString(value, 40000) && (!required || Boolean(value)) && !hasEmbeddedFile(value);
  const validQuestionFraction = (value) => typeof value === "number" && Number.isFinite(value) && value >= -1 && value <= 1;
  const validQuestionAnswer = (answer, numerical = false) => isObject(answer)
    && only(answer, numerical ? ["answer_text", "grade_fraction", "tolerance", "feedback"] : ["answer_text", "grade_fraction", "feedback"])
    && validQuestionRichText(answer.answer_text, true) && validQuestionFraction(answer.grade_fraction)
    && validQuestionRichText(answer.feedback) && (!numerical || (typeof answer.tolerance === "number" && Number.isFinite(answer.tolerance) && answer.tolerance >= 0));
  const validQuestionPairs = (value) => Array.isArray(value) && value.length >= 2 && value.length <= MAX_ITEMS
    && value.every((entry) => isObject(entry) && only(entry, ["question_text", "answer_text"])
      && validQuestionRichText(entry.question_text, true) && validString(entry.answer_text, 255) && Boolean(entry.answer_text));
  const validQuestionDistractors = (value) => Array.isArray(value) && value.length >= 1 && value.length <= MAX_ITEMS
    && value.every((entry) => validString(entry, 255) && Boolean(entry));
  const validGapselectChoiceText = (value) => validString(value, 255) && Boolean(value.trim()) && !/[<>]/.test(value);
  const validGapselectChoices = (qtype, value) => Array.isArray(value) && value.length >= 1 && value.length <= MAX_ITEMS
    && value.every((choice) => isObject(choice) && only(choice, qtype === "ddwtos" ? ["text", "group", "unlimited"] : ["text", "group"])
      && validGapselectChoiceText(choice.text) && Number.isSafeInteger(choice.group) && choice.group >= 1
      && choice.group <= (qtype === "gapselect" ? 20 : 8) && (qtype !== "ddwtos" || typeof choice.unlimited === "boolean"));
  const validGapselectSlots = (qtype, questionText, choices) => {
    if (!Array.isArray(choices)) return false;
    const matches = [...questionText.matchAll(/\[\[([^\]]*)\]/g)];
    if (!matches.length || questionText.replace(/\[\[[^\]]*\]\]/g, "").includes("[[")) return false;
    const slots = [];
    for (const match of matches) {
      if (!/^[1-9][0-9]*$/.test(match[1])) return false;
      const index = Number(match[1]) - 1;
      if (!Number.isSafeInteger(index) || !choices[index]) return false;
      slots.push(index);
    }
    return qtype !== "ddwtos" || slots.every((index) => slots.filter((candidate) => candidate === index).length === 1 || choices[index].unlimited);
  };
  const multianswerSource = (value) => {
    if (!validQuestionRichText(value, true)) return null;
    const pattern = /\{([1-9][0-9]*(?:[.,][0-9]+)?):SHORTANSWER:=([^~#{}\\]+)\}/g;
    const parts = [];
    let match;
    while ((match = pattern.exec(value))) {
      const mark = Number(match[1].replace(",", "."));
      const answer = match[2].trim();
      if (!Number.isFinite(mark) || mark <= 0 || !validGapselectChoiceText(answer)) return null;
      parts.push({ position: parts.length + 1, type: "shortanswer", mark, answer });
    }
    if (!parts.length || parts.length > MAX_ITEMS || /[{}]/.test(value.replace(pattern, ""))) return null;
    const totalMark = parts.reduce((total, part) => total + part.mark, 0);
    return Number.isFinite(totalMark) && totalMark > 0 && totalMark <= 1000000 ? { parts, total_mark: totalMark } : null;
  };
  const requestedQuestionMark = (qtype, value) => qtype === "multianswer" ? multianswerSource(value.question_text)?.total_mark ?? null : value.default_mark;
  const validQuestionArguments = (definition, value) => {
    const creation = definition.kind === "quiz-question-create-form-write";
    const qtype = definition.qtype;
    const hasNativeDefaultMark = qtype !== "multianswer";
    const base = creation
      ? ["course_id", "module_id", "name", "question_text", ...(hasNativeDefaultMark ? ["default_mark"] : []), "expected_digest"]
      : ["course_id", "module_id", "slot_id", "name", "question_text", ...(hasNativeDefaultMark ? ["default_mark"] : []), "expected_digest"];
    const byType = qtype === "multichoice" ? ["answers"]
      : qtype === "truefalse" ? ["correct_answer", "true_feedback", "false_feedback"]
        : ["shortanswer", "numerical"].includes(qtype) ? ["case_sensitive", "answers"]
          : qtype === "match" ? ["shuffle_answers", "pairs", "distractors"]
            : ["gapselect", "ddwtos"].includes(qtype) ? ["shuffle_answers", "choices"] : [];
    if (!only(value, [...base, ...byType]) || !validDigest(value.expected_digest)) return null;
    if (!creation && (!id(value.slot_id) || (value.name === undefined && value.question_text === undefined && value.default_mark === undefined && byType.every((key) => value[key] === undefined)))) return null;
    if ((creation || value.name !== undefined) && (!validString(value.name, 1333) || !value.name)) return null;
    if ((creation || value.question_text !== undefined) && !validQuestionRichText(value.question_text, true)) return null;
    if (hasNativeDefaultMark && (creation || value.default_mark !== undefined)) {
      if (!Number.isFinite(value.default_mark) || value.default_mark < 0 || value.default_mark > 1000000 || (qtype === "description" ? value.default_mark !== 0 : value.default_mark <= 0)) return null;
    }
    if (qtype === "multianswer" && (creation || value.question_text !== undefined) && !multianswerSource(value.question_text)) return null;
    if (qtype === "multichoice") {
      const validAnswer = (answer) => isObject(answer) && only(answer, ["answer_text", "correct_answer", "feedback"])
        && validQuestionRichText(answer.answer_text, true) && typeof answer.correct_answer === "boolean" && validQuestionRichText(answer.feedback);
      if ((creation || value.answers !== undefined) && (!Array.isArray(value.answers) || value.answers.length < 2 || value.answers.length > MAX_ITEMS
        || !value.answers.every(validAnswer) || (creation && value.answers.filter((answer) => answer.correct_answer).length !== 1))) return null;
    }
    if (qtype === "truefalse") {
      for (const field of ["correct_answer", "true_feedback", "false_feedback"]) {
        if ((creation || value[field] !== undefined) && (field === "correct_answer" ? typeof value[field] !== "boolean" : !validQuestionRichText(value[field]))) return null;
      }
    }
    if (["shortanswer", "numerical"].includes(qtype)) {
      const numerical = qtype === "numerical";
      if ((creation && qtype === "shortanswer" && typeof value.case_sensitive !== "boolean") || (value.case_sensitive !== undefined && (numerical || typeof value.case_sensitive !== "boolean"))) return null;
      if ((creation || value.answers !== undefined) && (!Array.isArray(value.answers) || !value.answers.length || value.answers.length > MAX_ITEMS
        || !value.answers.every((answer) => validQuestionAnswer(answer, numerical)) || (creation && !value.answers.some((answer) => answer.grade_fraction === 1)))) return null;
    }
    if (qtype === "match") {
      if ((creation && typeof value.shuffle_answers !== "boolean") || (value.shuffle_answers !== undefined && typeof value.shuffle_answers !== "boolean")) return null;
      const paired = value.pairs !== undefined || value.distractors !== undefined;
      if ((creation || paired) && (!validQuestionPairs(value.pairs) || !validQuestionDistractors(value.distractors))) return null;
    }
    if (["gapselect", "ddwtos"].includes(qtype)) {
      if ((creation && typeof value.shuffle_answers !== "boolean") || (value.shuffle_answers !== undefined && typeof value.shuffle_answers !== "boolean")) return null;
      if ((creation || value.choices !== undefined) && !validGapselectChoices(qtype, value.choices)) return null;
      if ((creation || value.question_text !== undefined) && !validGapselectSlots(qtype, value.question_text, value.choices)) return null;
    }
    return value;
  };
  const validateArguments = (definition, raw, binding, context) => {
    const value = withoutMorrow(raw);
    if (!value) return { error: "moodle_arguments_invalid" };
  const courseKinds = new Set(["course", "structure", "assignments", "quizzes", "quiz-questions-read", "quiz-question-read", "qbank-filter-inventory-read", "quiz-question-create-form-write", "quiz-question-write", "course-form-read", "section-form-read", "page-form-read", "label-form-read", "url-form-read", "forum-form-read", "choice-form-read", "book-form-read", "lesson-form-read", "glossary-form-read", "wiki-form-read", "feedback-form-read", "data-form-read", "folder-form-read", "folder-files-read", "imscp-form-read", "scorm-form-read", "book-chapters-read", "book-chapter-read", "book-chapter-create-form-read", "book-chapter-create-form-write", "book-chapter-form-write", "book-chapter-move", "book-chapter-show", "book-chapter-hide", "book-chapter-delete", "resource-files-read", "resource-file-create-form-read", "folder-file-create-form-read", "imscp-package-create-form-read", "scorm-package-create-form-read", "page-create-form-read", "label-create-form-read", "url-create-form-read", "forum-create-form-read", "choice-create-form-read", "book-create-form-read", "lesson-create-form-read", "glossary-create-form-read", "wiki-create-form-read", "feedback-create-form-read", "data-create-form-read", "assignment-form-read", "quiz-form-read", "assignment-create-form-read", "quiz-create-form-read", "assignment-overrides-read", "assignment-override-create", "assignment-override-write", "quiz-overrides-read", "quiz-override-create", "quiz-override-write", "course-form-write", "section-form-write", "page-form-write", "label-form-write", "url-form-write", "forum-form-write", "choice-form-write", "book-form-write", "lesson-form-write", "glossary-form-write", "wiki-form-write", "feedback-form-write", "data-form-write", "page-create-form-write", "label-create-form-write", "url-create-form-write", "forum-create-form-write", "choice-create-form-write", "book-create-form-write", "lesson-create-form-write", "glossary-create-form-write", "wiki-create-form-write", "feedback-create-form-write", "data-create-form-write", "resource-file-create-form-write", "folder-file-create-form-write", "resource-file-replace", "resource-file-delete", "folder-files-add", "folder-subfolder-create", "imscp-package-create-form-write", "scorm-package-create-form-write", "assignment-form-write", "quiz-form-write", "assignment-create-form-write", "quiz-create-form-write", "course-show", "course-hide", "section-show", "section-hide", "activity-show", "activity-hide", "activity-move"]);
    if (definition.kind === "list-courses") {
      if (!only(value, ["limit", "offset"])
        || (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > MAX_ITEMS))
        || (value.offset !== undefined && (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > MAX_DISCOVERY_OFFSET))) return { error: "moodle_arguments_invalid" };
      return { value: { limit: value.limit || 50, offset: value.offset || 0 } };
    }
    if (courseKinds.has(definition.kind)) {
      const courseId = courseArgument(value, binding, context);
      if (!courseId) return { error: "moodle_course_mismatch" };
      value.course_id = courseId;
    }
  const moduleKinds = new Set(["quiz-questions-read", "quiz-question-read", "qbank-filter-inventory-read", "quiz-question-create-form-write", "quiz-question-write", "page-form-read", "label-form-read", "url-form-read", "forum-form-read", "choice-form-read", "book-form-read", "lesson-form-read", "glossary-form-read", "wiki-form-read", "feedback-form-read", "data-form-read", "folder-form-read", "folder-files-read", "imscp-form-read", "scorm-form-read", "book-chapters-read", "book-chapter-read", "book-chapter-create-form-read", "book-chapter-create-form-write", "book-chapter-form-write", "book-chapter-move", "book-chapter-show", "book-chapter-hide", "book-chapter-delete", "resource-files-read", "resource-file-replace", "resource-file-delete", "folder-files-add", "folder-subfolder-create", "assignment-form-read", "quiz-form-read", "assignment-overrides-read", "assignment-override-create", "assignment-override-write", "quiz-overrides-read", "quiz-override-create", "quiz-override-write", "page-form-write", "label-form-write", "url-form-write", "forum-form-write", "choice-form-write", "book-form-write", "lesson-form-write", "glossary-form-write", "wiki-form-write", "feedback-form-write", "data-form-write", "assignment-form-write", "quiz-form-write", "activity-show", "activity-hide", "activity-move"]);
  const sectionKinds = new Set(["section-form-read", "section-form-write", "page-create-form-read", "page-create-form-write", "label-create-form-read", "label-create-form-write", "url-create-form-read", "forum-create-form-read", "url-create-form-write", "forum-create-form-write", "choice-create-form-read", "choice-create-form-write", "book-create-form-read", "book-create-form-write", "lesson-create-form-read", "lesson-create-form-write", "glossary-create-form-read", "glossary-create-form-write", "wiki-create-form-read", "wiki-create-form-write", "feedback-create-form-read", "feedback-create-form-write", "data-create-form-read", "data-create-form-write", "resource-file-create-form-read", "resource-file-create-form-write", "folder-file-create-form-read", "folder-file-create-form-write", "imscp-package-create-form-read", "imscp-package-create-form-write", "scorm-package-create-form-read", "scorm-package-create-form-write", "assignment-create-form-read", "assignment-create-form-write", "quiz-create-form-read", "quiz-create-form-write", "section-show", "section-hide"]);
    if (moduleKinds.has(definition.kind)) {
      if (!id(value.module_id)) return { error: "moodle_arguments_invalid" };
      value.module_id = id(value.module_id);
    }
    if (sectionKinds.has(definition.kind)) {
      if (!id(value.section_id)) return { error: "moodle_arguments_invalid" };
      value.section_id = id(value.section_id);
    }
    if (definition.kind === "quiz-question-read") {
      if (!id(value.slot_id) || !only(value, ["course_id", "module_id", "slot_id"])) return { error: "moodle_arguments_invalid" };
      value.slot_id = id(value.slot_id);
      return { value };
    }
    if (definition.kind === "qbank-filter-inventory-read") {
      if (!only(value, ["course_id", "module_id"])) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "quiz-question-write") {
      const checked = validQuestionArguments(definition, value);
      if (!checked) return { error: "moodle_arguments_invalid" };
      checked.slot_id = id(checked.slot_id);
      return { value: checked };
    }
    if (definition.kind === "book-chapters-read" || definition.kind === "assignment-overrides-read" || definition.kind === "quiz-overrides-read") {
      if (!only(value, ["course_id", "module_id"])) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "book-chapter-read") {
      if (!id(value.chapter_id) || !only(value, ["course_id", "module_id", "chapter_id"])) return { error: "moodle_arguments_invalid" };
      value.chapter_id = id(value.chapter_id);
      return { value };
    }
    if (definition.kind === "book-chapter-create-form-read") {
      if (!only(value, ["course_id", "module_id", "after_chapter_id", "subchapter"])
        || (value.after_chapter_id !== undefined && !id(value.after_chapter_id))
        || (value.subchapter !== undefined && !validBoolean(value.subchapter))) return { error: "moodle_arguments_invalid" };
      if (value.after_chapter_id !== undefined) value.after_chapter_id = id(value.after_chapter_id);
      return { value };
    }
    if (definition.kind === "book-chapter-create-form-write") {
      if (!only(value, ["course_id", "module_id", "after_chapter_id", "subchapter", "title", "content", "expected_digest"])
        || (value.after_chapter_id !== undefined && !id(value.after_chapter_id)) || !validBoolean(value.subchapter)
        || !validString(value.title, 1333) || !value.title || !validString(value.content, 40000) || !value.content || hasEmbeddedFile(value.content)
        || !validDigest(value.expected_digest)) return { error: "moodle_arguments_invalid" };
      if (value.after_chapter_id !== undefined) value.after_chapter_id = id(value.after_chapter_id);
      return { value };
    }
    if (definition.kind === "book-chapter-form-write") {
      if (!only(value, ["course_id", "module_id", "chapter_id", "title", "content", "expected_digest"])
        || !id(value.chapter_id) || (value.title === undefined && value.content === undefined)
        || (value.title !== undefined && (!validString(value.title, 1333) || !value.title))
        || (value.content !== undefined && (!validString(value.content, 40000) || hasEmbeddedFile(value.content)))
        || !validDigest(value.expected_digest)) return { error: "moodle_arguments_invalid" };
      value.chapter_id = id(value.chapter_id);
      return { value };
    }
    if (definition.kind === "book-chapter-move") {
      if (!only(value, ["course_id", "module_id", "chapter_id", "direction", "expected_digest"])
        || !id(value.chapter_id) || !["up", "down"].includes(value.direction) || !validDigest(value.expected_digest)) return { error: "moodle_arguments_invalid" };
      value.chapter_id = id(value.chapter_id);
      return { value };
    }
    if (definition.kind === "book-chapter-show" || definition.kind === "book-chapter-hide") {
      if (!only(value, ["course_id", "module_id", "chapter_id", "expected_digest"])
        || !id(value.chapter_id) || !validDigest(value.expected_digest)) return { error: "moodle_arguments_invalid" };
      value.chapter_id = id(value.chapter_id);
      return { value };
    }
    if (definition.kind === "book-chapter-delete") {
      if (!only(value, ["course_id", "module_id", "chapter_id", "expected_digest"])
        || !id(value.chapter_id) || !validDigest(value.expected_digest)) return { error: "moodle_arguments_invalid" };
      value.chapter_id = id(value.chapter_id);
      return { value };
    }
    const reads = new Set(["course", "structure", "assignments", "quizzes", "quiz-questions-read", "course-form-read", "section-form-read", "page-form-read", "label-form-read", "url-form-read", "forum-form-read", "choice-form-read", "book-form-read", "lesson-form-read", "glossary-form-read", "wiki-form-read", "feedback-form-read", "data-form-read", "resource-files-read", "resource-file-create-form-read", "folder-form-read", "folder-files-read", "folder-file-create-form-read", "imscp-form-read", "imscp-package-create-form-read", "scorm-form-read", "scorm-package-create-form-read", "page-create-form-read", "label-create-form-read", "url-create-form-read", "forum-create-form-read", "choice-create-form-read", "book-create-form-read", "lesson-create-form-read", "glossary-create-form-read", "wiki-create-form-read", "feedback-create-form-read", "data-create-form-read", "assignment-form-read", "quiz-form-read", "assignment-create-form-read", "quiz-create-form-read"]);
    if (reads.has(definition.kind)) {
      const allowed = creationModule(definition.kind) || definition.kind.startsWith("section") || (definition.kind.startsWith("resource-file-create") || definition.kind.startsWith("folder-file-create") || definition.kind.startsWith("imscp-package-create") || definition.kind.startsWith("scorm-package-create")) ? ["course_id", "section_id"]
        : (definition.kind.startsWith("page") || definition.kind.startsWith("label") || definition.kind.startsWith("url") || definition.kind.startsWith("forum") || definition.kind.startsWith("choice") || definition.kind.startsWith("book") || definition.kind.startsWith("lesson") || definition.kind.startsWith("glossary") || definition.kind.startsWith("wiki") || definition.kind.startsWith("feedback") || definition.kind.startsWith("data") || definition.kind.startsWith("resource") || definition.kind.startsWith("folder") || definition.kind.startsWith("imscp") || definition.kind.startsWith("scorm") || definition.kind.startsWith("assignment") || definition.kind.startsWith("quiz")) ? ["course_id", "module_id"]
          : ["course_id"];
      if (!only(value, allowed)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    const visibility = new Set(["course-show", "course-hide", "section-show", "section-hide", "activity-show", "activity-hide"]);
    if (visibility.has(definition.kind)) {
      const allowed = definition.kind.startsWith("course") ? ["course_id", "expected_digest"] : definition.kind.startsWith("section") ? ["course_id", "section_id", "expected_digest"] : ["course_id", "module_id", "expected_digest"];
      if (!only(value, allowed) || !validDigest(value.expected_digest)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "activity-move") {
      if (!id(value.target_section_id) || !only(value, ["course_id", "module_id", "target_section_id", "expected_digest"]) || !validDigest(value.expected_digest)) return { error: "moodle_arguments_invalid" };
      value.target_section_id = id(value.target_section_id);
      return { value };
    }
    if (!validDigest(value.expected_digest)) return { error: "moodle_arguments_invalid" };
    if (definition.kind === "course-form-write") {
      if (!only(value, ["course_id", "summary", "expected_digest"]) || !validString(value.summary, 40000)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "section-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "summary", "expected_digest"])
        || (value.name === undefined && value.summary === undefined)
        || (value.name !== undefined && !validString(value.name, 1333)) || (value.summary !== undefined && !validString(value.summary, 40000))) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "page-form-write") {
      if (!only(value, ["course_id", "module_id", "name", "content", "expected_digest"])
        || (value.name === undefined && value.content === undefined)
        || (value.name !== undefined && !validString(value.name, 1333)) || (value.content !== undefined && !validString(value.content, 40000))) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "label-form-write") {
      if (!only(value, ["course_id", "module_id", "content", "expected_digest"])
        || !validString(value.content, 40000) || hasEmbeddedFile(value.content)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "url-form-write") {
      if (!only(value, ["course_id", "module_id", "name", "external_url", "description", "expected_digest"])
        || (value.name === undefined && value.external_url === undefined && value.description === undefined)
        || (value.name !== undefined && (!validString(value.name, 1333) || !value.name))
        || (value.external_url !== undefined && (!validString(value.external_url, 40000) || !value.external_url || !webUrlValue(value.external_url)))
        || (value.description !== undefined && (!validString(value.description, 40000) || hasEmbeddedFile(value.description)))) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "page-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "content", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.content, 40000) || !value.content) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "label-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "content", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.content, 40000) || !value.content || hasEmbeddedFile(value.content)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "url-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "external_url", "description", "expected_digest"])
        || !validString(value.name, 1333) || !value.name
        || !validString(value.external_url, 40000) || !value.external_url || !webUrlValue(value.external_url)
        || !validString(value.description, 40000) || hasEmbeddedFile(value.description)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "forum-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "instructions", "forum_type", "subscription_mode", "tracking_type", "assessment", "due_date", "cutoff_at", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)
        || !validMoodleSelectValue(value.forum_type) || !validMoodleSelectValue(value.subscription_mode) || !validMoodleSelectValue(value.tracking_type)
        || !validForumAssessment(value.assessment) || !creationDatesValid("forum", value)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "choice-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "instructions", "display", "allow_update", "allow_multiple", "limit_answers", "show_available", "options", "limits", "open_at", "close_at", "show_preview", "show_results", "publish_names", "show_unanswered", "include_inactive", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)
        || !validMoodleSelectValue(value.display) || !validBoolean(value.allow_update) || !validBoolean(value.allow_multiple) || !validBoolean(value.limit_answers) || !validBoolean(value.show_available)
        || !validChoiceOptions(value.options) || !validChoiceLimits(value.limits, value.options, value.limit_answers)
        || !validBoolean(value.show_preview) || !validMoodleSelectValue(value.show_results) || !validMoodleSelectValue(value.publish_names)
        || !validBoolean(value.show_unanswered) || !validBoolean(value.include_inactive) || !creationDatesValid("choice", value)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "book-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "instructions", "numbering", "custom_titles", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)
        || !validMoodleSelectValue(value.numbering) || !validBoolean(value.custom_titles)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "lesson-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "instructions", "available_from", "deadline", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)
        || !creationDatesValid("lesson", value)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "glossary-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "instructions", "default_approval", "allow_comments", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)
        || !validBoolean(value.default_approval) || !validBoolean(value.allow_comments)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "wiki-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "instructions", "wiki_mode", "first_page_title", "default_format", "force_format", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)
        || !validMoodleSelectValue(value.wiki_mode) || !validString(value.first_page_title, 255) || !value.first_page_title
        || !validMoodleSelectValue(value.default_format) || !validBoolean(value.force_format)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "feedback-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "instructions", "anonymous", "open_at", "close_at", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)
        || !validMoodleSelectValue(value.anonymous) || !creationDatesValid("feedback", value)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "data-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "instructions", "approval", "available_from", "available_to", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)
        || !validBoolean(value.approval) || !creationDatesValid("data", value)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (["resource-file-create-form-write", "folder-file-create-form-write", "imscp-package-create-form-write", "scorm-package-create-form-write"].includes(definition.kind)) {
      if (!only(value, ["course_id", "section_id", "name", "filename", "size_bytes", "sha256", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validResourceFilename(value.filename)
        || !validStagedFileSize(value.size_bytes)
        || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
        || (definition.kind === "imscp-package-create-form-write" && !/\.(?:zip|imscc)$/i.test(value.filename))
        || (definition.kind === "scorm-package-create-form-write" && !/\.zip$/i.test(value.filename))) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "resource-file-replace") {
      if (!only(value, ["course_id", "module_id", "filename", "size_bytes", "sha256", "expected_digest"])
        || !validResourceFilename(value.filename) || !validStagedFileSize(value.size_bytes)
        || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "resource-file-delete") {
      if (!only(value, ["course_id", "module_id", "filename", "expected_digest"])
        || !validResourceFilename(value.filename)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "folder-files-add") {
      const files = Array.isArray(value.files) ? value.files : null;
      const named = files ? new Set(files.map((file) => isObject(file) ? file.filename : null)) : new Set();
      const total = files ? files.reduce((sum, file) => sum + (Number.isSafeInteger(file?.size_bytes) ? file.size_bytes : Number.MAX_SAFE_INTEGER), 0) : 0;
      if (!only(value, ["course_id", "module_id", "folder_path", "files", "expected_digest"])
        || (value.folder_path !== undefined && (typeof value.folder_path !== "string" || !folderPath(value.folder_path)))
        || !files || files.length < 1 || files.length > MAX_STAGED_FILES || named.size !== files.length
        || files.some((file) => !isObject(file) || !only(file, ["filename", "size_bytes", "sha256"])
          || !validResourceFilename(file.filename) || !validStagedFileSize(file.size_bytes)
          || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256))
        || !validStagedFileSize(total)) return { error: "moodle_arguments_invalid" };
      value.folder_path = folderPath(value.folder_path === undefined ? "/" : value.folder_path);
      return { value };
    }
    if (definition.kind === "folder-subfolder-create") {
      if (!only(value, ["course_id", "module_id", "parent_path", "name", "expected_digest"])
        || (value.parent_path !== undefined && (typeof value.parent_path !== "string" || !folderPath(value.parent_path)))
        || !validResourceFilename(value.name)) return { error: "moodle_arguments_invalid" };
      value.parent_path = folderPath(value.parent_path === undefined ? "/" : value.parent_path);
      return { value };
    }
    if (definition.kind === "assignment-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "instructions", "available_from", "due_date", "cutoff_at", "grading_due_at", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.instructions, 40000) || !creationDatesValid("assign", value)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "quiz-create-form-write") {
      if (!only(value, ["course_id", "section_id", "name", "instructions", "open_at", "close_at", "expected_digest"])
        || !validString(value.name, 1333) || !value.name || !validString(value.instructions, 40000) || !creationDatesValid("quiz", value)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "quiz-question-create-form-write") {
      const checked = validQuestionArguments(definition, value);
      return checked ? { value: checked } : { error: "moodle_arguments_invalid" };
    }
    if (definition.kind === "assignment-form-write") {
      const settingNames = assignmentSettings.map(({ argument }) => argument);
      const dateNames = assignmentDateFields.map(({ argument }) => argument);
      if (!only(value, ["course_id", "module_id", "name", "instructions", "grade", ...dateNames, ...settingNames, "expected_digest"])
        || ![...dateNames, ...settingNames, "name", "instructions", "grade"].some((name) => value[name] !== undefined)
        || (value.name !== undefined && !validString(value.name, 1333)) || (value.instructions !== undefined && !validString(value.instructions, 40000))
        || dateNames.some((name) => value[name] !== undefined && !validNullableDate(value[name])) || !assignmentDatesOrdered(value)
        || (value.grade !== undefined && !validAssignmentGrade(value.grade))
        || assignmentSettings.some((setting) => value[setting.argument] !== undefined && !validAssignmentSetting(setting, value[setting.argument]))) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (["assignment-override-create", "assignment-override-write", "quiz-override-create", "quiz-override-write"].includes(definition.kind)) {
      const update = definition.kind.endsWith("-write");
      const spec = overrideSpec[overrideModule(definition.kind)];
      const fieldNames = spec.fields.map(({ argument }) => argument);
      const clearable = spec.fields.filter(({ kind }) => kind !== "select").map(({ argument }) => argument);
      if (!only(value, ["course_id", "module_id", ...(update ? ["override_id"] : []), "user_id", "group_id", ...fieldNames, "expected_digest"])
        || (update && !id(value.override_id))
        || (value.user_id === undefined) === (value.group_id === undefined)
        || (value.user_id !== undefined && !id(value.user_id)) || (value.group_id !== undefined && !id(value.group_id))
        || spec.fields.some((field) => !validOverrideField(field, value[field.argument]))
        || !clearable.some((name) => value[name] !== null)
        || (spec.module === "assign" && !assignmentDatesOrdered(value))
        || (spec.module === "quiz" && value.open_at && value.close_at && compareDate(value.close_at, value.open_at) < 0)) return { error: "moodle_arguments_invalid" };
      if (update) value.override_id = id(value.override_id);
      if (value.user_id !== undefined) value.user_id = id(value.user_id);
      if (value.group_id !== undefined) value.group_id = id(value.group_id);
      return { value };
    }
    if (definition.kind === "quiz-form-write") {
      const settingNames = quizSettings.map(({ argument }) => argument);
      const dateNames = quizDateFields.map(({ argument }) => argument);
      const writable = [...dateNames, ...settingNames, "name", "instructions", "review_options", "overall_feedback_bands", "password"];
      if (!only(value, ["course_id", "module_id", ...writable, "expected_digest"])
        || !writable.some((name) => value[name] !== undefined)
        || (value.name !== undefined && !validString(value.name, 1333)) || (value.instructions !== undefined && !validString(value.instructions, 40000))
        || dateNames.some((name) => value[name] !== undefined && !validNullableDate(value[name]))
        || (value.open_at && value.close_at && compareDate(value.close_at, value.open_at) < 0)
        || quizSettings.some((setting) => value[setting.argument] !== undefined && !validQuizSetting(setting, value[setting.argument]))
        || (value.review_options !== undefined && !validQuizReviewOptions(value.review_options))
        || (value.overall_feedback_bands !== undefined && !validQuizFeedbackBands(value.overall_feedback_bands))
        || (value.password !== undefined && value.password !== null)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "forum-form-write") {
      if (!only(value, ["course_id", "module_id", "name", "instructions", "forum_type", "subscription_mode", "tracking_type", "assessment", "due_date", "cutoff_at", "expected_digest"])
        || (value.name === undefined && value.instructions === undefined && value.forum_type === undefined && value.subscription_mode === undefined && value.tracking_type === undefined && value.assessment === undefined && value.due_date === undefined && value.cutoff_at === undefined)
        || (value.name !== undefined && (!validString(value.name, 1333) || !value.name)) || (value.instructions !== undefined && (!validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)))
        || (value.forum_type !== undefined && !validMoodleSelectValue(value.forum_type)) || (value.subscription_mode !== undefined && !validMoodleSelectValue(value.subscription_mode)) || (value.tracking_type !== undefined && !validMoodleSelectValue(value.tracking_type))
        || (value.assessment !== undefined && !validForumAssessment(value.assessment))
        || (value.due_date !== undefined && !validNullableDate(value.due_date)) || (value.cutoff_at !== undefined && !validNullableDate(value.cutoff_at))
        || (value.due_date && value.cutoff_at && compareDate(value.cutoff_at, value.due_date) < 0)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "choice-form-write") {
      const responseDependent = value.options !== undefined || value.limits !== undefined || value.allow_multiple !== undefined || value.limit_answers !== undefined || value.show_available !== undefined;
      if (!only(value, ["course_id", "module_id", "name", "instructions", "display", "allow_update", "allow_multiple", "limit_answers", "show_available", "options", "limits", "open_at", "close_at", "show_preview", "show_results", "publish_names", "show_unanswered", "include_inactive", "expected_digest"])
        || (value.name === undefined && value.instructions === undefined && value.display === undefined && value.allow_update === undefined && value.allow_multiple === undefined && value.limit_answers === undefined && value.show_available === undefined && value.options === undefined && value.limits === undefined && value.open_at === undefined && value.close_at === undefined && value.show_preview === undefined && value.show_results === undefined && value.publish_names === undefined && value.show_unanswered === undefined && value.include_inactive === undefined)
        || (value.name !== undefined && (!validString(value.name, 1333) || !value.name)) || (value.instructions !== undefined && (!validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)))
        || (value.display !== undefined && !validMoodleSelectValue(value.display)) || (value.allow_update !== undefined && !validBoolean(value.allow_update)) || (value.allow_multiple !== undefined && !validBoolean(value.allow_multiple)) || (value.limit_answers !== undefined && !validBoolean(value.limit_answers)) || (value.show_available !== undefined && !validBoolean(value.show_available))
        || (value.options !== undefined && (!validChoiceOptions(value.options) || value.limit_answers === undefined)) || (value.limits !== undefined && (!Array.isArray(value.options) || !validChoiceLimits(value.limits, value.options, value.limit_answers === undefined ? true : value.limit_answers)))
        || ((value.options === undefined) !== (value.limits === undefined))
        || (responseDependent && value.options === undefined && (value.limits !== undefined || value.allow_multiple !== undefined || value.limit_answers !== undefined || value.show_available !== undefined))
        || (value.open_at !== undefined && !validNullableDate(value.open_at)) || (value.close_at !== undefined && !validNullableDate(value.close_at)) || (value.open_at && value.close_at && compareDate(value.close_at, value.open_at) < 0)
        || (value.show_preview !== undefined && !validBoolean(value.show_preview)) || (value.show_results !== undefined && !validMoodleSelectValue(value.show_results)) || (value.publish_names !== undefined && !validMoodleSelectValue(value.publish_names)) || (value.show_unanswered !== undefined && !validBoolean(value.show_unanswered)) || (value.include_inactive !== undefined && !validBoolean(value.include_inactive))) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "book-form-write") {
      if (!only(value, ["course_id", "module_id", "name", "instructions", "numbering", "custom_titles", "expected_digest"])
        || (value.name === undefined && value.instructions === undefined && value.numbering === undefined && value.custom_titles === undefined)
        || (value.name !== undefined && (!validString(value.name, 1333) || !value.name))
        || (value.instructions !== undefined && (!validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)))
        || (value.numbering !== undefined && !validMoodleSelectValue(value.numbering))
        || (value.custom_titles !== undefined && !validBoolean(value.custom_titles))) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "lesson-form-write") {
      if (!only(value, ["course_id", "module_id", "name", "instructions", "available_from", "deadline", "expected_digest"])
        || (value.name === undefined && value.instructions === undefined && value.available_from === undefined && value.deadline === undefined)
        || (value.name !== undefined && (!validString(value.name, 1333) || !value.name))
        || (value.instructions !== undefined && (!validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)))
        || (value.available_from !== undefined && !validNullableDate(value.available_from))
        || (value.deadline !== undefined && !validNullableDate(value.deadline))
        || (value.available_from && value.deadline && compareDate(value.deadline, value.available_from) < 0)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "glossary-form-write") {
      if (!only(value, ["course_id", "module_id", "name", "instructions", "default_approval", "allow_comments", "expected_digest"])
        || (value.name === undefined && value.instructions === undefined && value.default_approval === undefined && value.allow_comments === undefined)
        || (value.name !== undefined && (!validString(value.name, 1333) || !value.name))
        || (value.instructions !== undefined && (!validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)))
        || (value.default_approval !== undefined && !validBoolean(value.default_approval)) || (value.allow_comments !== undefined && !validBoolean(value.allow_comments))) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "wiki-form-write") {
      if (!only(value, ["course_id", "module_id", "name", "instructions", "default_format", "force_format", "expected_digest"])
        || (value.name === undefined && value.instructions === undefined && value.default_format === undefined && value.force_format === undefined)
        || (value.name !== undefined && (!validString(value.name, 1333) || !value.name))
        || (value.instructions !== undefined && (!validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)))
        || (value.default_format !== undefined && !validMoodleSelectValue(value.default_format)) || (value.force_format !== undefined && !validBoolean(value.force_format))) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "feedback-form-write") {
      if (!only(value, ["course_id", "module_id", "name", "instructions", "anonymous", "open_at", "close_at", "expected_digest"])
        || (value.name === undefined && value.instructions === undefined && value.anonymous === undefined && value.open_at === undefined && value.close_at === undefined)
        || (value.name !== undefined && (!validString(value.name, 1333) || !value.name))
        || (value.instructions !== undefined && (!validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)))
        || (value.anonymous !== undefined && !validMoodleSelectValue(value.anonymous))
        || (value.open_at !== undefined && !validNullableDate(value.open_at)) || (value.close_at !== undefined && !validNullableDate(value.close_at))
        || (value.open_at && value.close_at && compareDate(value.close_at, value.open_at) < 0)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    if (definition.kind === "data-form-write") {
      if (!only(value, ["course_id", "module_id", "name", "instructions", "approval", "available_from", "available_to", "expected_digest"])
        || (value.name === undefined && value.instructions === undefined && value.approval === undefined && value.available_from === undefined && value.available_to === undefined)
        || (value.name !== undefined && (!validString(value.name, 1333) || !value.name))
        || (value.instructions !== undefined && (!validString(value.instructions, 40000) || hasEmbeddedFile(value.instructions)))
        || (value.approval !== undefined && !validBoolean(value.approval))
        || (value.available_from !== undefined && !validNullableDate(value.available_from)) || (value.available_to !== undefined && !validNullableDate(value.available_to))
        || (value.available_from && value.available_to && compareDate(value.available_to, value.available_from) < 0)) return { error: "moodle_arguments_invalid" };
      return { value };
    }
    return { error: "moodle_arguments_invalid" };
  };
  const readText = async (response) => {
    const declaredLength = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_BYTES) throw new Error("too large");
    const reader = response.body?.getReader?.();
    if (!reader) {
      if (!response.body) return "";
      throw new Error("stream unavailable");
    }
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const raw = next.value;
        if (!raw || !Number.isSafeInteger(raw.byteLength) || raw.byteLength < 0) throw new Error("stream chunk invalid");
        const chunk = new Uint8Array(raw.byteLength);
        for (let index = 0; index < raw.byteLength; index += 1) chunk[index] = raw[index];
        total += chunk.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          throw new Error("too large");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  };
  const draftItemId = (value) => typeof value === "string" && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) ? value : "";
  // Moodle's own draft-area actions. Source:
  // https://github.com/moodle/moodle/blob/v5.2.2/public/repository/draftfiles_ajax.php
  const draftFilesAction = async (context, action, params) => {
    let response;
    try {
      response = await fetch(urlFor(context, "/repository/draftfiles_ajax.php", { action }), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ sesskey: context.sesskey, ...params }),
      });
    } catch {
      return null;
    }
    let text;
    try { text = await readText(response); } catch { return null; }
    if (!response.ok) return null;
    let payload;
    try { payload = JSON.parse(text); } catch { return null; }
    return isObject(payload) ? payload : null;
  };
  const readDraftListing = async (context, itemId, filepath = "/") => draftFilesAction(context, "list", { itemid: itemId, filepath });
  const inspectFileManagers = async (context, form, formData) => {
    const managers = [];
    const seen = new Set();
    const inspect = async (name, value) => {
      seen.add(name);
      const itemId = draftItemId(value);
      const listing = itemId ? await readDraftListing(context, itemId) : null;
      const state = !listing || !Number.isSafeInteger(listing.filecount) || listing.filecount < 0 || !Array.isArray(listing.list)
        ? "unverified" : listing.filecount === 0 && listing.list.length === 0 ? "empty" : "nonempty";
      managers.push({ name, state, listing });
    };
    for (const input of form.querySelectorAll('[data-fieldtype="filemanager"] input[type="hidden"][name]')) {
      const name = String(input.getAttribute("name") || "");
      if (!name || seen.has(name)) continue;
      await inspect(name, formData.get(name));
    }
    for (const name of new Set(Array.from(formData.keys()).filter((entry) => /\[itemid\]$/.test(entry)))) {
      if (seen.has(name)) continue;
      const values = formData.getAll(name);
      await inspect(name, values.length === 1 ? values[0] : "");
    }
    return managers;
  };
  const ajax = async (context, methodName, args, write = false) => {
    let response;
    try {
      response = await fetch(urlFor(context, "/lib/ajax/service.php", { sesskey: context.sesskey, info: methodName }), {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify([{ index: 0, methodname: methodName, args }]),
      });
    } catch {
      return { ok: false, sent: write, outcomeUnknown: write, error: "moodle_ajax_request_failed" };
    }
    let text;
    try { text = await readText(response); } catch { return { ok: false, sent: write, status: response.status, outcomeUnknown: write, error: "moodle_ajax_response_invalid" }; }
    let payload;
    try { payload = JSON.parse(text); } catch { return { ok: false, sent: write, status: response.status, outcomeUnknown: write, error: "moodle_ajax_response_invalid" }; }
    const entry = Array.isArray(payload) && payload.length === 1 && isObject(payload[0]) ? payload[0] : null;
    if (!response.ok || !entry || entry.error || entry.exception) return { ok: false, sent: write, status: response.status, outcomeUnknown: write, error: "moodle_ajax_failed" };
    return { ok: true, sent: true, status: response.status, data: sanitize(entry.data) };
  };
  const state = async (context, courseId) => {
    const response = await ajax(context, "core_courseformat_get_state", { courseid: Number(courseId) });
    if (!response.ok || typeof response.data !== "string") return { ok: false, sent: false, status: response.status, error: response.error || "moodle_state_invalid" };
    let value;
    try { value = JSON.parse(response.data); } catch { return { ok: false, sent: false, status: response.status, error: "moodle_state_invalid" }; }
    if (!isObject(value) || !isObject(value.course) || id(value.course.id) !== courseId || !Array.isArray(value.section) || !Array.isArray(value.cm)) return { ok: false, sent: false, status: response.status, error: "moodle_state_invalid" };
    return { ok: true, sent: true, status: response.status, data: sanitize(value) };
  };
  const contentData = (value) => ({
    course: sanitize(value.course),
    sections: value.section.map((entry) => sanitize(entry)).slice(0, 10_000),
    activities: value.cm.map((entry) => sanitize(entry)).slice(0, 10_000),
  });
  const stateRead = async (context, courseId, filter = "") => {
    const result = await state(context, courseId);
    if (!result.ok) return result;
    let data = contentData(result.data);
    if (filter) data = { course: data.course, activities: data.activities.filter((entry) => entry.module === filter) };
    return { ...result, data, snapshot_digest: await digest(data), targets: [courseTarget(context, result.data.course.fullname || result.data.course.name)] };
  };
  const selectedSection = async (context, courseId, sectionId) => {
    const current = await state(context, courseId);
    if (!current.ok) return current;
    const section = current.data.section.find((entry) => id(entry?.id) === sectionId);
    if (!section || !sectionNumber(section.number)) return { ok: false, sent: false, status: current.status, error: "moodle_section_target_invalid" };
    return { ok: true, sent: true, status: current.status, section };
  };
  const formDescriptor = (context, kind, args) => {
    const courseId = args.course_id;
    if (kind.startsWith("course")) return {
      type: "course", expectedPath: "/course/edit.php", endpoint: urlFor(context, "/course/edit.php", { id: courseId }), expected: { id: courseId }, required: ["summary_editor[text]", "visible"], courseId,
    };
    if (kind.startsWith("section")) return {
      type: "section", expectedPath: "/course/editsection.php", endpoint: urlFor(context, "/course/editsection.php", { id: args.section_id }), expected: { id: args.section_id, course: courseId }, required: ["name", "summary_editor[text]"], courseId, sectionId: args.section_id,
    };
    const stagedFileModule = kind.startsWith("resource-file") ? "resource" : kind.startsWith("folder-file") ? "folder" : "";
    if (stagedFileModule && kind.endsWith("create-form-read")) return {
      type: `${stagedFileModule}-file-create`, module: stagedFileModule, creation: true, expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { add: stagedFileModule, course: courseId, sectionid: args.section_id, return: 0 }), expected: { course: courseId, add: stagedFileModule, modulename: stagedFileModule, section: args.section_number, return: "0" }, required: ["course", "add", "modulename", "section", "return", "name", "visible", "files", "revision"], courseId, sectionId: args.section_id, sectionNumber: args.section_number, sectionName: args.section_name, submitName: "submitbutton2", strictIdentity: true, actionRoute: { add: stagedFileModule, course: courseId, sectionid: args.section_id, return: 0 },
    };
    const creationModuleName = creationModule(kind);
    if (creationModuleName) {
      const spec = creationSpec[creationModuleName];
      const requiredFields = (spec.fields || []).filter(({ kind, field }) => kind !== "boolean" && !(spec.module === "book" && field === "customtitles")).map(({ field }) => field);
      return {
        type: spec.type, module: spec.module, creation: true, expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { add: spec.module, course: courseId, sectionid: args.section_id, return: 0 }), expected: { course: courseId, add: spec.module, modulename: spec.module, section: args.section_number, return: "0" }, required: ["course", "add", "modulename", "section", "return", "name", spec.body, "visible", ...requiredFields, ...spec.dates.map(({ field }) => `${field}[enabled]`)], courseId, sectionId: args.section_id, sectionNumber: args.section_number, sectionName: args.section_name, ...(spec.submitName ? { submitName: spec.submitName } : {}), ...(spec.strictIdentity ? { strictIdentity: true } : {}),
      };
    }
    const fileListingModule = ["resource-files-read", "resource-file-replace", "resource-file-delete"].includes(kind) ? "resource"
      : ["folder-files-read", "folder-files-add", "folder-subfolder-create"].includes(kind) ? "folder" : "";
    if (fileListingModule) return {
      type: fileListingModule, expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, course: courseId, modulename: fileListingModule }, required: fileListingModule === "folder" ? ["name", "files", "display", "showexpanded", "showdownloadfolder", "forcedownload"] : ["name", "files"], courseId, moduleId: args.module_id, strictIdentity: true, finalRoute: { update: args.module_id, return: "0" }, ...(kind.endsWith("-read") ? {} : { submitName: "submitbutton2" }),
    };
    if (kind === "folder-form-read") return {
      type: "folder", expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, course: courseId, modulename: "folder" }, required: ["name", "files", "display", "showexpanded", "showdownloadfolder", "forcedownload"], courseId, moduleId: args.module_id, strictIdentity: true, finalRoute: { update: args.module_id, return: "0" },
    };
    if (kind === "imscp-form-read") return {
      type: "imscp", expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, course: courseId, modulename: "imscp" }, required: ["name", "package", "keepold"], courseId, moduleId: args.module_id, strictIdentity: true, finalRoute: { update: args.module_id, return: "0" },
    };
    if (kind === "imscp-package-create-form-read") return {
      type: "imscp-package-create", module: "imscp", creation: true, expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { add: "imscp", course: courseId, sectionid: args.section_id, return: 0 }), expected: { course: courseId, add: "imscp", modulename: "imscp", section: args.section_number, return: "0" }, required: ["course", "add", "modulename", "section", "return", "name", "package", "keepold", "visible"], courseId, sectionId: args.section_id, sectionNumber: args.section_number, sectionName: args.section_name, submitName: "submitbutton2", strictIdentity: true,
    };
    if (kind === "scorm-form-read") return {
      type: "scorm", expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, course: courseId, modulename: "scorm" }, required: ["name", "packagefile", "scormtype", "updatefreq", "popup"], courseId, moduleId: args.module_id, strictIdentity: true, finalRoute: { update: args.module_id, return: "0" },
    };
    if (kind === "scorm-package-create-form-read") return {
      type: "scorm-package-create", module: "scorm", creation: true, expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { add: "scorm", course: courseId, sectionid: args.section_id, return: 0 }), expected: { course: courseId, add: "scorm", modulename: "scorm", section: args.section_number, return: "0" }, required: ["course", "add", "modulename", "section", "return", "name", "packagefile", "scormtype", "updatefreq", "popup", "visible"], courseId, sectionId: args.section_id, sectionNumber: args.section_number, sectionName: args.section_name, submitName: "submitbutton2", strictIdentity: true,
    };
    if (kind.startsWith("label")) return {
      type: "label", expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, course: courseId, modulename: "label" }, required: ["name", "introeditor[text]"], courseId, moduleId: args.module_id, submitName: "submitbutton2",
    };
    if (kind.startsWith("url")) return {
      type: "url", expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, return: "0", course: courseId, modulename: "url" }, required: ["name", "externalurl", "introeditor[text]"], courseId, moduleId: args.module_id, submitName: "submitbutton2", strictIdentity: true, actionRoute: { update: args.module_id, return: "0" },
    };
    if (kind.startsWith("forum")) return {
      type: "forum", expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, return: "0", course: courseId, modulename: "forum" }, required: ["name", "introeditor[text]", "type", "forcesubscribe", "trackingtype", "duedate[enabled]", "cutoffdate[enabled]"], courseId, moduleId: args.module_id,
    };
    if (kind.startsWith("choice")) return {
      type: "choice", expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, return: "0", course: courseId, modulename: "choice" }, required: ["name", "introeditor[text]", "display", "limitanswers", "showavailable", "option[0]", "timeopen[enabled]", "timeclose[enabled]", "showresults", "publish", "showunanswered", "includeinactive"], courseId, moduleId: args.module_id,
    };
    if (kind.startsWith("book")) return {
      type: "book", expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, return: "0", course: courseId, modulename: "book" }, required: ["name", "introeditor[text]", "numbering"], courseId, moduleId: args.module_id,
    };
    if (kind.startsWith("lesson")) return {
      type: "lesson", expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, return: "0", course: courseId, modulename: "lesson" }, required: ["name", "introeditor[text]", "available[enabled]", "deadline[enabled]", "mediafile"], courseId, moduleId: args.module_id,
    };
    if (kind.startsWith("glossary")) return {
      type: "glossary", expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, return: "0", course: courseId, modulename: "glossary" }, required: ["name", "introeditor[text]", "defaultapproval", "allowcomments"], courseId, moduleId: args.module_id,
    };
    if (kind.startsWith("wiki")) return {
      type: "wiki", expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, return: "0", course: courseId, modulename: "wiki" }, required: ["name", "introeditor[text]", "defaultformat"], courseId, moduleId: args.module_id,
    };
    if (kind.startsWith("feedback")) return {
      type: "feedback", expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, return: "0", course: courseId, modulename: "feedback" }, required: ["name", "introeditor[text]", "anonymous", "timeopen[enabled]", "timeclose[enabled]"], courseId, moduleId: args.module_id,
    };
    if (kind.startsWith("data")) return {
      type: "data", expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, return: "0", course: courseId, modulename: "data" }, required: ["name", "introeditor[text]", "approval", "timeavailablefrom[enabled]", "timeavailableto[enabled]"], courseId, moduleId: args.module_id,
    };
    const module = kind.startsWith("page") ? "page" : kind.startsWith("assignment") ? "assign" : "quiz";
    const required = module === "page" ? ["name", "page[text]"] : module === "assign" ? ["name", "introeditor[text]", "duedate[enabled]"] : ["name", "introeditor[text]", "timeopen[enabled]", "timeclose[enabled]"];
    return {
      type: module, expectedPath: "/course/modedit.php", endpoint: urlFor(context, "/course/modedit.php", { update: args.module_id, return: 0 }), expected: { update: args.module_id, course: courseId, modulename: module }, required, courseId, moduleId: args.module_id,
    };
  };
  const nativeFormIdentity = (descriptor) => {
    const expected = { ...descriptor.expected };
    if (descriptor.expectedPath !== "/course/modedit.php") return expected;
    if (descriptor.creation) {
      return { ...expected, course: descriptor.courseId, add: descriptor.module, modulename: descriptor.module, section: descriptor.sectionNumber, return: "0" };
    }
    return { ...expected, update: descriptor.moduleId, course: descriptor.courseId, modulename: descriptor.type };
  };
  const nativeFormIdentityMatches = (formData, descriptor) => {
    const expected = nativeFormIdentity(descriptor);
    const strict = descriptor.strictIdentity || descriptor.expectedPath === "/course/modedit.php";
    return Object.entries(expected).every(([name, value]) => (!strict || formData.getAll(name).length === 1) && String(formData.get(name) || "") === String(value));
  };
  const nativeFormActionRoute = (descriptor) => {
    if (descriptor.actionRoute) return descriptor.actionRoute;
    if (descriptor.expectedPath !== "/course/modedit.php") return null;
    return descriptor.creation
      ? { add: descriptor.module, course: descriptor.courseId, sectionid: descriptor.sectionId, return: "0" }
      : { update: descriptor.moduleId, return: "0" };
  };
  const valuesFromForm = (formData, form, fileManagers = []) => {
    const fileManagerStates = new Map(fileManagers.map(({ name, state }) => [name, state]));
    const values = {};
    for (const [name, value] of formData.entries()) {
      const fileManagerState = fileManagerStates.get(name);
      if (fileManagerState) {
        if (values[name] === undefined) values[name] = { filemanager: { state: fileManagerState } };
        continue;
      }
      if (transientField(name)) continue;
      if (typeof File !== "undefined" && value instanceof File) {
        if (value.size > 0) throw new Error("file edit refused");
        continue;
      }
      if (typeof value !== "string") throw new Error("form invalid");
      const safeValue = redact(value);
      if (values[name] === undefined) values[name] = safeValue;
      else if (Array.isArray(values[name])) values[name].push(safeValue);
      else values[name] = [values[name], safeValue];
    }
    for (const control of form.querySelectorAll('input[type="checkbox"][name$="[enabled]"]')) {
      if (control.checked) continue;
      values[control.name] = "0";
      const prefix = control.name.slice(0, -"[enabled]".length);
      for (const component of ["year", "month", "day", "hour", "minute"]) delete values[`${prefix}[${component}]`];
    }
    return values;
  };
  const nativeFormSesskey = (context, formData) => {
    const values = formData.getAll("sesskey");
    return values.length === 1 && typeof values[0] === "string" && values[0] === context.sesskey ? values[0] : "";
  };
  const one = (values, name) => typeof values[name] === "string" ? values[name] : "";
  const dateFromForm = (values, name) => {
    if (one(values, `${name}[enabled]`) !== "1") return null;
    const date = {
      year: Number(one(values, `${name}[year]`)), month: Number(one(values, `${name}[month]`)), day: Number(one(values, `${name}[day]`)), hour: Number(one(values, `${name}[hour]`)), minute: Number(one(values, `${name}[minute]`)),
    };
    return validDate(date) ? date : null;
  };
  const namedControls = (documentValue, name) => Array.from(documentValue?.querySelectorAll?.("[name]") || []).filter((control) => control.getAttribute("name") === name);
  const selectedControlValue = (documentValue, name) => {
    const selects = namedControls(documentValue, name).filter((control) => control.tagName === "SELECT");
    if (selects.length !== 1) return "";
    const selected = Array.from(selects[0].options || []).filter((option) => option.selected);
    return selected.length === 1 ? String(selected[0].value || "") : "";
  };
  const availableSelectValues = (documentValue, name) => {
    const selects = namedControls(documentValue, name).filter((control) => control.tagName === "SELECT");
    if (selects.length !== 1) return [];
    const values = Array.from(selects[0].options || []).map((option) => String(option.value || "")).filter(Boolean);
    return values.length <= MAX_ITEMS && new Set(values).size === values.length ? values : [];
  };
  const controlValue = (documentValue, values, name) => one(values, name) || selectedControlValue(documentValue, name);
  const textControlValue = (documentValue, values, name) => {
    const current = one(values, name);
    if (current) return current;
    const controls = namedControls(documentValue, name).filter((control) => ["INPUT", "TEXTAREA"].includes(control.tagName));
    return controls.length === 1 && typeof controls[0].value === "string" ? controls[0].value : "";
  };
  const booleanControlValue = (documentValue, values, name) => {
    const controls = namedControls(documentValue, name);
    const checkboxes = controls.filter((control) => String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    if (checkboxes.length === 1 && controls.every((control) => control === checkboxes[0] || String(control.getAttribute("type") || "").toLowerCase() === "hidden")) return Boolean(checkboxes[0].checked);
    const value = controlValue(documentValue, values, name);
    return value === "0" ? false : value === "1" ? true : null;
  };
  const specFieldValue = (documentValue, values, specField) => specField.kind === "boolean"
    ? booleanControlValue(documentValue, values, specField.field)
    : specField.kind === "select" ? controlValue(documentValue, values, specField.field) : one(values, specField.field);
  const choiceOptionRows = (values) => {
    const indexes = Object.keys(values).map((name) => name.match(/^option\[([0-9]+)\]$/)).filter(Boolean).map((match) => Number(match[1]));
    if (!indexes.length || indexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= MAX_ITEMS)) return null;
    const rows = [];
    for (let index = 0; index <= Math.max(...indexes); index += 1) {
      const text = one(values, `option[${index}]`);
      if (!text) continue;
      const rawLimit = one(values, `limit[${index}]`);
      if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit))) return null;
      rows.push({ index, text, limit: Number(rawLimit) });
    }
    return rows;
  };
  const assessmentData = (documentValue, values) => {
    const type = controlValue(documentValue, values, "grade_forum[modgrade_type]");
    if (type === "none") return { type };
    const rawPoint = controlValue(documentValue, values, "grade_forum[modgrade_point]");
    return type === "point" && /^\d+$/.test(rawPoint) && Number.isSafeInteger(Number(rawPoint)) ? { type, maximum_points: Number(rawPoint) } : null;
  };
  const assignmentGradeData = (documentValue, values) => {
    const type = controlValue(documentValue, values, "grade[modgrade_type]");
    if (type === "none") return { type };
    if (type === "scale") {
      const scale = controlValue(documentValue, values, "grade[modgrade_scale]");
      return scale ? { type, scale } : null;
    }
    const rawPoint = controlValue(documentValue, values, "grade[modgrade_point]");
    return type === "point" && /^\d+$/.test(rawPoint) && Number.isSafeInteger(Number(rawPoint)) ? { type, maximum_points: Number(rawPoint) } : null;
  };
  const assignmentSettingValue = (documentValue, values, setting) => {
    if (setting.kind === "boolean") return booleanControlValue(documentValue, values, setting.field);
    if (setting.kind === "select") return controlValue(documentValue, values, setting.field);
    if (setting.kind === "count") {
      if (one(values, setting.enabledField) !== "1") return null;
      const raw = textControlValue(documentValue, values, setting.field);
      return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
    }
    return textControlValue(documentValue, values, setting.field);
  };
  const assignmentSubmissionsFrozen = (documentValue, values) => Object.hasOwn(values, "blindmarking")
    && namedControls(documentValue, "blindmarking").filter((control) => control.tagName === "SELECT" && !control.disabled).length !== 1;
  // Moodle formats a saved number for the form with the site language's decimal
  // separator, so a boundary that was sent as 80 comes back as "80.00" or
  // "80,00". A band boundary is therefore compared as a number, not as text.
  const nativeFloat = (value) => {
    const text = String(value ?? "").trim();
    return /^-?[0-9]+(?:[.,][0-9]+)?$/.test(text) ? Number(text.replace(",", ".")) : null;
  };
  // A native duration is a number and a unit in seconds, with an enable box.
  const durationFromForm = (values, name) => {
    if (one(values, `${name}[enabled]`) !== "1") return null;
    const number = one(values, `${name}[number]`);
    const unit = one(values, `${name}[timeunit]`);
    if (!/^[0-9]+$/.test(number) || !/^[0-9]+$/.test(unit)) return null;
    const seconds = Number(number) * Number(unit);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
  };
  const quizSettingValue = (documentValue, values, setting) => {
    if (setting.kind === "boolean") return booleanControlValue(documentValue, values, setting.field);
    if (setting.kind === "select") return controlValue(documentValue, values, setting.field);
    if (setting.kind === "duration") return durationFromForm(values, setting.field);
    return textControlValue(documentValue, values, setting.field);
  };
  const quizReviewOptions = (documentValue, values) => Object.fromEntries(quizReviewFields.map(({ argument, field }) => [
    argument,
    Object.fromEntries(quizReviewWhens.map((when) => [when, booleanControlValue(documentValue, values, `${field}${when}`)])),
  ]));
  // The native overall-feedback repeat: rows 0..n-1 each carry a feedback
  // editor, rows 0..n-2 also carry the grade boundary above the row below.
  const quizFeedbackRowNames = (names) => {
    const indexes = new Set(names.map((name) => name.match(/^feedbacktext\[([0-9]+)\]\[text\]$/)).filter(Boolean).map((match) => Number(match[1])));
    if (!indexes.size || indexes.size > QUIZ_FEEDBACK_LIMIT || [...indexes].some((index) => !Number.isSafeInteger(index) || index < 0)) return null;
    const rows = [];
    for (let index = 0; index < indexes.size; index += 1) {
      if (!indexes.has(index)) return null;
      rows.push({ index, boundary: names.includes(`feedbackboundaries[${index}]`) });
    }
    return rows;
  };
  const quizFeedbackBands = (values) => {
    const rows = quizFeedbackRowNames(Object.keys(values));
    if (!rows) return null;
    const bands = rows.map((row) => ({ feedback: one(values, `feedbacktext[${row.index}][text]`), lower_boundary: row.boundary ? nativeFloat(values[`feedbackboundaries[${row.index}]`]) : null }));
    let used = 0;
    for (const [index, band] of bands.entries()) if (band.feedback || band.lower_boundary !== null) used = index + 1;
    return bands.slice(0, used);
  };
  const quizPasswordSet = (documentValue) => {
    const controls = namedControls(documentValue, "quizpassword").filter((control) => control.tagName === "INPUT");
    return controls.length === 1 ? Boolean(String(controls[0].getAttribute("value") || "")) : null;
  };
  const selectedControlLabel = (documentValue, name) => {
    const selects = namedControls(documentValue, name).filter((control) => control.tagName === "SELECT");
    if (selects.length !== 1) return "";
    const selected = Array.from(selects[0].options || []).filter((option) => option.selected);
    return selected.length === 1 ? String(selected[0].textContent || "").trim().replace(/\s+/g, " ").slice(0, 500) : "";
  };
  const choiceHasResponses = (documentValue) => namedControls(documentValue, "allowmultiple").some((control) => Boolean(control.disabled));
  const formDataFor = (descriptor, values, documentValue) => {
    if (descriptor.type === "course") return { course_id: Number(descriptor.courseId), fullname: one(values, "fullname"), shortname: one(values, "shortname"), summary: one(values, "summary_editor[text]"), summary_format: Number(one(values, "summary_editor[format]")), visible: one(values, "visible") === "1" };
    if (descriptor.type === "section") return { course_id: Number(descriptor.courseId), section_id: Number(descriptor.sectionId), name: one(values, "name"), summary: one(values, "summary_editor[text]"), summary_format: Number(one(values, "summary_editor[format]")) };
    if (descriptor.type === "resource-file-create" || descriptor.type === "folder-file-create") return { course_id: Number(descriptor.courseId), section_id: Number(descriptor.sectionId), name: one(values, "name"), visible: one(values, "visible") === "1" };
    if (descriptor.creation && descriptor.module === "forum") return {
      course_id: Number(descriptor.courseId), section_id: Number(descriptor.sectionId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), forum_type: controlValue(documentValue, values, "type"), subscription_mode: controlValue(documentValue, values, "forcesubscribe"), tracking_type: controlValue(documentValue, values, "trackingtype"), assessment: assessmentData(documentValue, values), due_date: dateFromForm(values, "duedate"), cutoff_at: dateFromForm(values, "cutoffdate"), available_forum_types: availableSelectValues(documentValue, "type"), available_subscription_modes: availableSelectValues(documentValue, "forcesubscribe"), available_tracking_types: availableSelectValues(documentValue, "trackingtype"), visible: one(values, "visible") === "1",
    };
    if (descriptor.creation && descriptor.module === "choice") {
      const rows = choiceOptionRows(values);
      return {
        course_id: Number(descriptor.courseId), section_id: Number(descriptor.sectionId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), display: controlValue(documentValue, values, "display"), allow_update: booleanControlValue(documentValue, values, "allowupdate"), allow_multiple: booleanControlValue(documentValue, values, "allowmultiple"), limit_answers: booleanControlValue(documentValue, values, "limitanswers"), show_available: booleanControlValue(documentValue, values, "showavailable"), options: rows ? rows.map(({ text }) => text) : null, limits: rows ? rows.map(({ limit }) => limit) : null, open_at: dateFromForm(values, "timeopen"), close_at: dateFromForm(values, "timeclose"), show_preview: booleanControlValue(documentValue, values, "showpreview"), show_results: controlValue(documentValue, values, "showresults"), publish_names: controlValue(documentValue, values, "publish"), show_unanswered: booleanControlValue(documentValue, values, "showunanswered"), include_inactive: booleanControlValue(documentValue, values, "includeinactive"), has_responses: choiceHasResponses(documentValue), available_display_modes: availableSelectValues(documentValue, "display"), available_result_modes: availableSelectValues(documentValue, "showresults"), available_publish_modes: availableSelectValues(documentValue, "publish"), visible: one(values, "visible") === "1",
      };
    }
    if (descriptor.creation && descriptor.module === "book") return {
      course_id: Number(descriptor.courseId), section_id: Number(descriptor.sectionId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), numbering: controlValue(documentValue, values, "numbering"), custom_titles: booleanControlValue(documentValue, values, "customtitles"), available_numbering: availableSelectValues(documentValue, "numbering"), visible: one(values, "visible") === "1",
    };
    if (descriptor.creation && descriptor.module === "lesson") return {
      course_id: Number(descriptor.courseId), section_id: Number(descriptor.sectionId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), available_from: dateFromForm(values, "available"), deadline: dateFromForm(values, "deadline"), media_file_state: values.mediafile?.filemanager?.state || "unverified", visible: one(values, "visible") === "1",
    };
    if (descriptor.type === "imscp-package-create") return { course_id: Number(descriptor.courseId), section_id: Number(descriptor.sectionId), name: one(values, "name"), visible: one(values, "visible") === "1", keep_old_packages: controlValue(documentValue, values, "keepold") };
    if (descriptor.type === "scorm-package-create") return { course_id: Number(descriptor.courseId), section_id: Number(descriptor.sectionId), name: one(values, "name"), visible: one(values, "visible") === "1", package_type: controlValue(documentValue, values, "scormtype"), update_frequency: controlValue(documentValue, values, "updatefreq"), display_mode: controlValue(documentValue, values, "popup") };
    if (descriptor.creation) {
      const spec = creationSpec[descriptor.module];
      const data = { course_id: Number(descriptor.courseId), section_id: Number(descriptor.sectionId), name: one(values, "name"), [spec.dataBody]: one(values, spec.body), [`${spec.dataBody}_format`]: Number(one(values, spec.body.replace("[text]", "[format]"))), visible: one(values, "visible") === "1" };
      for (const specField of spec.fields || []) data[specField.argument] = specFieldValue(documentValue, values, specField);
      for (const { argument, field } of spec.dates) data[argument] = dateFromForm(values, field);
      return data;
    }
    if (descriptor.type === "folder") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), display: controlValue(documentValue, values, "display"), show_expanded: booleanControlValue(documentValue, values, "showexpanded"), show_download_folder: booleanControlValue(documentValue, values, "showdownloadfolder"), force_download: booleanControlValue(documentValue, values, "forcedownload"), file_state: values.files?.filemanager?.state || "unverified" };
    if (descriptor.type === "imscp") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), keep_old_packages: controlValue(documentValue, values, "keepold"), package_state: "not_read" };
    if (descriptor.type === "scorm") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), package_type: controlValue(documentValue, values, "scormtype"), update_frequency: controlValue(documentValue, values, "updatefreq"), display_mode: controlValue(documentValue, values, "popup"), package_state: "not_read" };
    if (descriptor.type === "page") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), content: one(values, "page[text]"), content_format: Number(one(values, "page[format]")) };
    if (descriptor.type === "label") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), content: one(values, "introeditor[text]"), content_format: Number(one(values, "introeditor[format]")) };
    if (descriptor.type === "url") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), external_url: one(values, "externalurl"), description: one(values, "introeditor[text]"), description_format: Number(one(values, "introeditor[format]")) };
    if (descriptor.type === "forum") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), forum_type: controlValue(documentValue, values, "type"), subscription_mode: controlValue(documentValue, values, "forcesubscribe"), tracking_type: controlValue(documentValue, values, "trackingtype"), assessment: assessmentData(documentValue, values), due_date: dateFromForm(values, "duedate"), cutoff_at: dateFromForm(values, "cutoffdate"), available_forum_types: availableSelectValues(documentValue, "type"), available_subscription_modes: availableSelectValues(documentValue, "forcesubscribe"), available_tracking_types: availableSelectValues(documentValue, "trackingtype") };
    if (descriptor.type === "choice") {
      const rows = choiceOptionRows(values);
      return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), display: controlValue(documentValue, values, "display"), allow_update: booleanControlValue(documentValue, values, "allowupdate"), allow_multiple: booleanControlValue(documentValue, values, "allowmultiple"), limit_answers: booleanControlValue(documentValue, values, "limitanswers"), show_available: booleanControlValue(documentValue, values, "showavailable"), options: rows ? rows.map(({ text }) => text) : null, limits: rows ? rows.map(({ limit }) => limit) : null, open_at: dateFromForm(values, "timeopen"), close_at: dateFromForm(values, "timeclose"), show_preview: booleanControlValue(documentValue, values, "showpreview"), show_results: controlValue(documentValue, values, "showresults"), publish_names: controlValue(documentValue, values, "publish"), show_unanswered: booleanControlValue(documentValue, values, "showunanswered"), include_inactive: booleanControlValue(documentValue, values, "includeinactive"), has_responses: choiceHasResponses(documentValue), available_display_modes: availableSelectValues(documentValue, "display"), available_result_modes: availableSelectValues(documentValue, "showresults"), available_publish_modes: availableSelectValues(documentValue, "publish") };
    }
    if (descriptor.type === "book-chapter") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), chapter_id: Number(one(values, "id")), title: one(values, "title"), content: one(values, "content_editor[text]"), content_format: Number(one(values, "content_editor[format]")), pagenum: Number(one(values, "pagenum")), subchapter: booleanControlValue(documentValue, values, "subchapter"), content_file_state: values["content_editor[itemid]"]?.filemanager?.state || "unverified" };
    if (descriptor.type === "book") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), numbering: controlValue(documentValue, values, "numbering"), custom_titles: booleanControlValue(documentValue, values, "customtitles"), available_numbering: availableSelectValues(documentValue, "numbering") };
    if (descriptor.type === "lesson") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), available_from: dateFromForm(values, "available"), deadline: dateFromForm(values, "deadline"), media_file_state: values.mediafile?.filemanager?.state || "unverified" };
    if (descriptor.type === "glossary") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), default_approval: booleanControlValue(documentValue, values, "defaultapproval"), allow_comments: booleanControlValue(documentValue, values, "allowcomments") };
    if (descriptor.type === "wiki") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), wiki_mode: controlValue(documentValue, values, "wikimode"), first_page_title: textControlValue(documentValue, values, "firstpagetitle"), default_format: controlValue(documentValue, values, "defaultformat"), force_format: booleanControlValue(documentValue, values, "forceformat"), available_formats: availableSelectValues(documentValue, "defaultformat") };
    if (descriptor.type === "feedback") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), anonymous: controlValue(documentValue, values, "anonymous"), open_at: dateFromForm(values, "timeopen"), close_at: dateFromForm(values, "timeclose"), available_anonymous_modes: availableSelectValues(documentValue, "anonymous") };
    if (descriptor.type === "data") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")), approval: booleanControlValue(documentValue, values, "approval"), available_from: dateFromForm(values, "timeavailablefrom"), available_to: dateFromForm(values, "timeavailableto") };
    if (descriptor.type === "resource") return { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name") };
    if (descriptor.type === "assign-override" || descriptor.type === "quiz-override") {
      const spec = overrideSpec[descriptor.module];
      return {
        override_id: descriptor.overrideId ? Number(descriptor.overrideId) : null,
        scope: descriptor.scope,
        ...(descriptor.scope === "group"
          ? { group_id: Number(controlValue(documentValue, values, "groupid")) || null, group_name: selectedControlLabel(documentValue, "groupid") }
          : { user_id: Number(controlValue(documentValue, values, "userid")) || null }),
        ...Object.fromEntries(spec.fields.map(({ argument, field, kind }) => [
          argument,
          kind === "date" ? dateFromForm(values, field) : kind === "duration" ? durationFromForm(values, field) : controlValue(documentValue, values, field),
        ])),
      };
    }
    if (descriptor.type === "assign") {
      const data = { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")) };
      for (const { argument, field } of assignmentDateFields) data[argument] = dateFromForm(values, field);
      for (const setting of assignmentSettings) {
        data[setting.argument] = assignmentSettingValue(documentValue, values, setting);
        if (setting.available) data[setting.available] = availableSelectValues(documentValue, setting.field);
      }
      data.grade = assignmentGradeData(documentValue, values);
      data.available_grade_types = availableSelectValues(documentValue, "grade[modgrade_type]");
      data.available_grade_scales = availableSelectValues(documentValue, "grade[modgrade_scale]");
      data.submissions_or_grades_exist = assignmentSubmissionsFrozen(documentValue, values);
      return data;
    }
    const data = { course_id: Number(descriptor.courseId), module_id: Number(descriptor.moduleId), name: one(values, "name"), instructions: one(values, "introeditor[text]"), instructions_format: Number(one(values, "introeditor[format]")) };
    for (const { argument, field } of quizDateFields) data[argument] = dateFromForm(values, field);
    for (const setting of quizSettings) {
      data[setting.argument] = quizSettingValue(documentValue, values, setting);
      if (setting.available) data[setting.available] = availableSelectValues(documentValue, setting.field);
    }
    data.review_options = quizReviewOptions(documentValue, values);
    data.overall_feedback_bands = quizFeedbackBands(values);
    data.available_overall_feedback_rows = (quizFeedbackRowNames(Object.keys(values)) || []).length;
    data.password_set = quizPasswordSet(documentValue);
    data.safe_exam_browser = controlValue(documentValue, values, "seb_requiresafeexambrowser") || null;
    return data;
  };
  const loadForm = async (context, descriptor) => {
    let response;
    try { response = await fetch(descriptor.endpoint, { method: "GET", credentials: "include", cache: "no-store", headers: { Accept: "text/html" } }); } catch { return { ok: false, sent: false, error: "moodle_form_read_failed" }; }
    let text;
    try { text = await readText(response); } catch { return { ok: false, sent: false, status: response.status, error: "moodle_form_read_failed" }; }
    if (!response.ok || typeof DOMParser === "undefined" || typeof FormData === "undefined" || (descriptor.finalRoute && !finalRouteMatches(response.url, descriptor.endpoint, descriptor.finalRoute))) return { ok: false, sent: false, status: response.status, error: "moodle_form_read_failed" };
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(text, "text/html"); } catch { return { ok: false, sent: false, status: response.status, error: "moodle_form_read_failed" }; }
    const forms = Array.from(documentValue.querySelectorAll("form")).filter((form) => {
      if (String(form.getAttribute("method") || "get").toLowerCase() !== "post") return false;
      try {
        const candidate = new FormData(form);
        return nativeFormIdentityMatches(candidate, descriptor);
      } catch { return false; }
    });
    if (forms.length !== 1) return { ok: false, sent: false, status: response.status, error: "moodle_form_target_invalid" };
    const form = forms[0];
    let action;
    try { action = new URL(form.getAttribute("action") || descriptor.endpoint, descriptor.endpoint); } catch { return { ok: false, sent: false, status: response.status, error: "moodle_form_target_invalid" }; }
    const expectedEndpoint = new URL(descriptor.endpoint);
    const actionRoute = nativeFormActionRoute(descriptor);
    if (action.origin !== expectedEndpoint.origin || action.pathname !== expectedEndpoint.pathname
      || (actionRoute && (action.hash || (action.search && !finalRouteMatches(action.toString(), descriptor.endpoint, actionRoute))))) return { ok: false, sent: false, status: response.status, error: "moodle_form_target_invalid" };
    const submitName = descriptor.submitName || (descriptor.type === "course" ? "saveanddisplay" : "submitbutton");
    const submitControl = Array.from(form.querySelectorAll('input[type="submit"]')).find((control) => control.name === submitName && !control.disabled && typeof control.value === "string" && control.value);
    if (descriptor.submitName && !submitControl) return { ok: false, sent: false, status: response.status, error: "moodle_form_target_invalid" };
    let formData;
    let nativeSesskey;
    try { formData = new FormData(form); } catch { return { ok: false, sent: false, status: response.status, error: "moodle_form_read_failed" }; }
    nativeSesskey = nativeFormSesskey(context, formData);
    if (!nativeSesskey) return { ok: false, sent: false, status: response.status, error: "moodle_form_session_mismatch" };
    let values;
    let fileManagers;
    try {
      fileManagers = await inspectFileManagers(context, form, formData);
      values = valuesFromForm(formData, form, fileManagers);
    } catch { return { ok: false, sent: false, status: response.status, error: "moodle_form_read_failed" }; }
    if (descriptor.required.some((name) => !Object.hasOwn(values, name))) return { ok: false, sent: false, status: response.status, error: "moodle_form_target_invalid" };
    return { ok: true, sent: true, status: response.status, action: action.toString(), formData, values, fileManagers, submit: submitControl ? { name: submitName, value: submitControl.value } : null, data: formDataFor(descriptor, values, documentValue), snapshot_digest: await digest(values), descriptor, context, nativeSesskey, document: documentValue };
  };
  const protectedDigest = (values, names) => {
    const copy = { ...values };
    for (const name of names) delete copy[name];
    return digest(copy);
  };
  const setField = (formData, name, value) => { formData.delete(name); formData.append(name, String(value)); };
  const dateFieldNames = (name) => [`${name}[enabled]`, `${name}[year]`, `${name}[month]`, `${name}[day]`, `${name}[hour]`, `${name}[minute]`];
  const setDate = (formData, name, value) => {
    if (value === null) {
      formData.delete(`${name}[enabled]`);
      return;
    }
    setField(formData, `${name}[enabled]`, 1);
    for (const [key, item] of Object.entries(value)) setField(formData, `${name}[${key}]`, item);
  };
  const isSameFormValidation = (text, form) => {
    if (typeof DOMParser === "undefined") return false;
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(text, "text/html"); } catch { return false; }
    const actionUrl = new URL(form.action);
    return Array.from(documentValue.querySelectorAll("form")).some((candidate) => {
      if (String(candidate.getAttribute("method") || "get").toLowerCase() !== "post") return false;
      try {
        const action = new URL(candidate.getAttribute("action") || form.action, form.action);
        if (action.origin !== actionUrl.origin || action.pathname !== actionUrl.pathname) return false;
        const values = new FormData(candidate);
        return nativeFormIdentityMatches(values, form.descriptor);
      } catch { return false; }
    });
  };
  const postForm = async (form) => {
    const current = currentContext();
    if (!sameContext(form.context, current)) return error("moodle_binding_mismatch");
    const proof = await (typeof form.revalidate === "function" ? form.revalidate(current) : loadForm(current, form.descriptor));
    if (!proof.ok) return { ...proof, sent: false };
    if (proof.nativeSesskey !== form.nativeSesskey) return error("moodle_form_session_mismatch");
    if (proof.snapshot_digest !== form.snapshot_digest) return error("moodle_form_changed");
    if (!form.submit || !proof.submit) return { ok: false, sent: false, error: "moodle_form_submit_missing" };
    if (proof.action !== form.action || proof.submit.name !== form.submit.name || proof.submit.value !== form.submit.value) return { ok: false, sent: false, error: "moodle_form_target_invalid" };
    if (proof.fileManagers.some(({ state }) => state === "nonempty")) return { ok: false, sent: false, error: "moodle_filemanager_nonempty" };
    if (proof.fileManagers.some(({ state }) => state !== "empty")) return { ok: false, sent: false, error: "moodle_filemanager_unverified" };
    const params = new URLSearchParams();
    try {
      for (const [name, value] of form.formData.entries()) {
        if (typeof File !== "undefined" && value instanceof File) {
          if (value.size > 0) return { ok: false, sent: false, error: "moodle_file_edit_refused" };
          continue;
        }
        if (typeof value !== "string") return { ok: false, sent: false, error: "moodle_form_invalid" };
        params.append(name, value);
      }
      params.set(form.submit.name, form.submit.value);
    } catch { return { ok: false, sent: false, error: "moodle_form_invalid" }; }
    let response;
    try {
      response = await fetch(form.action, { method: "POST", credentials: "include", cache: "no-store", redirect: "follow", headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: params });
    } catch { return { ok: false, sent: true, outcomeUnknown: true, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_write_response_unknown" }, error: "moodle_write_response_unknown" }; }
    let text;
    try { text = await readText(response); } catch { return { ok: false, sent: true, status: response.status, outcomeUnknown: true, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_write_response_unknown" }, error: "moodle_write_response_unknown" }; }
    if (!response.ok) return { ok: false, sent: true, status: response.status, outcomeUnknown: true, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_form_write_failed" }, error: "moodle_form_write_failed" };
    let finalUrl;
    let actionUrl;
    try { finalUrl = new URL(response.url || form.action); actionUrl = new URL(form.action); } catch { return { ok: false, sent: true, status: response.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_form_write_not_redirected" }, error: "moodle_form_write_not_redirected" }; }
    if (!response.redirected) {
      if (finalUrl.origin === actionUrl.origin && finalUrl.pathname === actionUrl.pathname && isSameFormValidation(text, form)) {
        return { ok: false, sent: true, status: response.status, outcomeUnknown: false, verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: "moodle_form_validation_failed" }, error: "moodle_form_validation_failed" };
      }
      return { ok: false, sent: true, status: response.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_form_write_not_redirected" }, error: "moodle_form_write_not_redirected" };
    }
    if (finalUrl.origin !== actionUrl.origin || finalUrl.pathname === actionUrl.pathname) {
      return { ok: false, sent: true, status: response.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_form_redirect_refused" }, error: "moodle_form_redirect_refused" };
    }
    return { ok: true, sent: true, status: response.status, redirectUrl: finalUrl.toString() };
  };
  const courseTarget = (context, name = "") => ({ field: "course_id", label: "Course", name: String(name || context.profile.courseName || "Moodle course") });
  const sectionTarget = (section) => ({ field: "section_id", label: "Section", name: String(section?.title || section?.rawtitle || "Selected course section") });
  const formTargets = (context, descriptor, data) => {
    const course = courseTarget(context, data.fullname);
    if (descriptor.type === "section") return [course, { field: "section_id", label: "Section", name: String(data.name || descriptor.sectionId) }];
    if (descriptor.creation) return [course, { field: "section_id", label: "Section", name: String(descriptor.sectionName || "Selected course section") }];
    if (descriptor.type === "label") return [course, { field: "module_id", label: "Text and media area", name: String(data.name || descriptor.moduleId) }];
    if (descriptor.type === "url") return [course, { field: "module_id", label: "URL resource", name: String(data.name || descriptor.moduleId) }];
    if (descriptor.type === "forum") return [course, { field: "module_id", label: "Forum", name: String(data.name || descriptor.moduleId) }];
    if (descriptor.type === "choice") return [course, { field: "module_id", label: "Choice", name: String(data.name || descriptor.moduleId) }];
    if (descriptor.type === "glossary") return [course, { field: "module_id", label: "Glossary", name: String(data.name || descriptor.moduleId) }];
    if (descriptor.type === "wiki") return [course, { field: "module_id", label: "Wiki", name: String(data.name || descriptor.moduleId) }];
    if (descriptor.type === "feedback") return [course, { field: "module_id", label: "Feedback", name: String(data.name || descriptor.moduleId) }];
    if (descriptor.type === "data") return [course, { field: "module_id", label: "Database", name: String(data.name || descriptor.moduleId) }];
    if (descriptor.type === "book-chapter") return [course, { field: "module_id", label: "Book", name: String(descriptor.bookName || descriptor.moduleId) }, { field: "chapter_id", label: "Chapter", name: String(data.title || descriptor.chapterId || "New chapter") }];
    if (["page", "assign", "quiz", "book", "lesson"].includes(descriptor.type)) return [course, { field: "module_id", label: descriptor.type === "book" ? "Book" : descriptor.type === "lesson" ? "Lesson" : "Activity", name: String(data.name || descriptor.moduleId) }];
    return [course];
  };
  const finalRouteMatches = (actualValue, endpoint, required) => {
    let actual;
    let expected;
    try { actual = new URL(actualValue || endpoint); expected = new URL(endpoint); } catch { return false; }
    return actual.origin === expected.origin && actual.pathname === expected.pathname
      && [...actual.searchParams.keys()].length === Object.keys(required).length
      && Object.entries(required).every(([name, value]) => actual.searchParams.getAll(name).length === 1 && actual.searchParams.get(name) === String(value));
  };
  const jsonObjectAt = (source, start) => {
    let index = start;
    while (/\s/.test(source[index] || "")) index += 1;
    if (source[index] !== "{") return "";
    const begin = index;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) return source.slice(begin, index + 1);
    }
    return "";
  };
  const nativeMoodleConfig = (documentValue) => {
    const configs = [];
    for (const script of documentValue.querySelectorAll("script:not([src])")) {
      const source = String(script.textContent || "");
      if (source.length > MAX_BYTES || source.includes("\u0000")) return null;
      const assignments = /\bM\.cfg\s*=\s*/g;
      let match;
      while ((match = assignments.exec(source))) {
        const json = jsonObjectAt(source, assignments.lastIndex);
        if (!json) return null;
        let config;
        try { config = JSON.parse(json); } catch { return null; }
        if (!isObject(config)) return null;
        configs.push(config);
        assignments.lastIndex += json.length;
      }
    }
    return configs.length === 1 ? configs[0] : null;
  };
  const nativeMoodleSessionMatches = (context, config) => {
    if (!isObject(config) || typeof config.wwwroot !== "string" || typeof config.sesskey !== "string" || !config.sesskey || id(config.userId) !== context.profile.principalId) return false;
    let root;
    try { root = new URL(config.wwwroot); } catch { return false; }
    return root.protocol === "https:" && !root.search && !root.hash && !root.username && !root.password
      && root.origin === context.profile.origin && root.href === context.profile.siteUrl && config.sesskey === context.sesskey;
  };
  const loadCourseName = async (context, courseId) => {
    if (!sameContext(context, currentContext())) return error("moodle_binding_mismatch");
    const endpoint = urlFor(context, "/course/view.php", { id: courseId });
    let response;
    try { response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", headers: { Accept: "text/html" } }); } catch { return error("moodle_course_unavailable"); }
    let text;
    try { text = await readText(response); } catch { return { ...error("moodle_course_unavailable"), status: response.status }; }
    if (!sameContext(context, currentContext())) return error("moodle_binding_mismatch");
    if (!response.ok || typeof DOMParser === "undefined" || !finalRouteMatches(response.url, endpoint, { id: courseId })) return { ...error("moodle_course_unavailable"), status: response.status };
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(text, "text/html"); } catch { return { ...error("moodle_course_unavailable"), status: response.status }; }
    const pageCourse = String(documentValue.body?.className || "").match(/(?:^|\s)course-([1-9][0-9]*)(?:\s|$)/)?.[1] || "";
    const headings = Array.from(documentValue.querySelectorAll("h1"));
    const name = headings.length === 1 ? nativeText(headings[0].textContent, 500)?.trim().replace(/\s+/g, " ") || "" : "";
    const nativeConfig = nativeMoodleConfig(documentValue);
    if (pageCourse !== courseId || !name || !nativeMoodleSessionMatches(context, nativeConfig)) return { ...error("moodle_binding_mismatch"), status: response.status };
    return { ok: true, sent: true, status: response.status, name };
  };
  const loadQuizDocument = async (context, path, params, failure) => {
    const endpoint = urlFor(context, path, params);
    let response;
    try { response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", headers: { Accept: "text/html" } }); } catch { return error(failure); }
    let text;
    try { text = await readText(response); } catch { return { ...error(failure), status: response.status }; }
    if (!response.ok || typeof DOMParser === "undefined" || !finalRouteMatches(response.url, endpoint, params)) return { ...error(failure), status: response.status };
    try { return { ok: true, sent: true, status: response.status, document: new DOMParser().parseFromString(text, "text/html") }; } catch { return { ...error(failure), status: response.status }; }
  };
  const quizTargets = (context, course, quiz) => [courseTarget(context, course.fullname || course.name), { field: "module_id", label: "Quiz", name: String(quiz.name || quiz.id) }];
  const quizBinding = async (context, args) => {
    const current = await state(context, args.course_id);
    if (!current.ok) return current;
    const quiz = current.data.cm.find((entry) => id(entry?.id) === args.module_id && entry?.module === "quiz");
    if (!quiz) return error("moodle_quiz_target_invalid");
    return { ok: true, sent: true, status: current.status, course: current.data.course, quiz };
  };
  const questionBankFilterInventory = async (context, args) => {
    const expected = new URL(urlFor(context, "/question/edit.php"));
    let current;
    try { current = new URL(globalThis.location?.href || ""); } catch { return error("moodle_question_bank_filter_inventory_page_unavailable"); }
    if (current.origin !== expected.origin || current.pathname !== expected.pathname || current.searchParams.get("cmid") !== args.module_id) {
      return error("moodle_question_bank_filter_inventory_page_unavailable");
    }
    const bank = await state(context, args.course_id);
    if (!bank.ok) return bank;
    const matches = bank.data.cm.filter((entry) => id(entry?.id) === args.module_id && ["qbank", "quiz"].includes(String(entry?.module || "")));
    if (matches.length !== 1) return error("moodle_question_bank_filter_inventory_target_invalid", { status: bank.status });
    const region = globalThis.document?.querySelector?.('[data-filterregion="filtertypedata"]');
    if (!region) return error("moodle_question_bank_filter_inventory_unavailable");
    const seen = new Set();
    const filter_conditions = [];
    for (const field of region.querySelectorAll('select[data-field-name]')) {
      const key = String(field.getAttribute("data-field-name") || "").trim();
      const title = String(field.getAttribute("data-field-title") || "").trim();
      const required = String(field.getAttribute("data-required") || "").trim();
      const filterClass = String(field.getAttribute("data-filter-type-class") || "").trim();
      if (!/^[a-z][a-z0-9_]{0,159}$/i.test(key) || !validString(title, 500) || !["true", "false"].includes(required) || seen.has(key)) {
        return error("moodle_question_bank_filter_inventory_unavailable");
      }
      seen.add(key);
      filter_conditions.push({ key, title, required: required === "true", ...(filterClass ? { javascript_filter_class: filterClass } : {}) });
    }
    if (!filter_conditions.length) return error("moodle_question_bank_filter_inventory_unavailable");
    filter_conditions.sort((left, right) => left.key.localeCompare(right.key));
    const data = {
      course_id: Number(args.course_id),
      module_id: Number(args.module_id),
      module_type: matches[0].module,
      filter_conditions,
      provider_condition_classes: "not_exposed",
      plugin_components: "not_exposed",
      question_bank_isolation_eligible: false,
      reason: "moodle_qbank_filter_class_inventory_unavailable",
    };
    return { ok: true, sent: true, status: bank.status, data, targets: [courseTarget(context, bank.data.course.fullname || bank.data.course.name), { field: "module_id", label: "Question bank source", name: String(matches[0].name || matches[0].id) }], snapshot_digest: await digest(data) };
  };
  const bookBinding = async (context, args) => {
    const current = await state(context, args.course_id);
    if (!current.ok) return current;
    const matches = current.data.cm.filter((entry) => id(entry?.id) === args.module_id && entry?.module === "book");
    if (matches.length !== 1) return error("moodle_book_target_invalid");
    const name = nativeText(matches[0].name, 1333);
    if (!name) return error("moodle_book_target_invalid");
    return { ok: true, sent: true, status: current.status, course: current.data.course, book: matches[0], name };
  };
  const moduleFileBinding = async (context, args, module) => {
    const current = await state(context, args.course_id);
    if (!current.ok) return current;
    const matches = current.data.cm.filter((entry) => id(entry?.id) === args.module_id);
    if (matches.length !== 1 || matches[0]?.module !== module) return error(`moodle_${module}_target_invalid`);
    const name = nativeText(matches[0].name, 1333);
    if (!name) return error(`moodle_${module}_target_invalid`);
    return { ok: true, sent: true, status: current.status, course: current.data.course, module: matches[0], name };
  };
  const resourceBinding = async (context, args) => moduleFileBinding(context, args, "resource");
  const nativeText = (value, maximum = MAX_BYTES) => typeof value === "string" && value.length <= maximum && !value.includes("\u0000") ? value : null;
  const validResourceFilename = (value) => typeof value === "string" && value.length > 0 && value.length <= 255 && value === value.trim()
    && value !== "." && value !== ".." && !/[\\/\u0000-\u001f]/.test(value);
  const resourceFileManifest = (value) => {
    if (!isObject(value) || !validResourceFilename(value.filename) || !validStagedFileSize(value.size_bytes)
      || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) return null;
    return { filename: value.filename, size_bytes: value.size_bytes, sha256: value.sha256 };
  };
  const readLimitedBytes = async (response, maximum = 1024 * 1024) => {
    const declaredLength = Number(response.headers?.get?.("content-length") || 0);
    if (Number.isSafeInteger(declaredLength) && declaredLength > maximum) throw new Error("too large");
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error("stream unavailable");
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const raw = next.value;
        if (!raw || !Number.isSafeInteger(raw.byteLength) || raw.byteLength < 0) throw new Error("stream chunk invalid");
        const chunk = new Uint8Array(raw.byteLength);
        for (let index = 0; index < raw.byteLength; index += 1) chunk[index] = raw[index];
        total += chunk.byteLength;
        if (total > maximum) { await reader.cancel(); throw new Error("too large"); }
        chunks.push(chunk);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  };
  const bytesDigest = async (bytes) => {
    if (!globalThis.crypto?.subtle) throw new Error("digest unavailable");
    const digestValue = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digestValue), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const exactPrivateResourceFile = async (inputValue, args) => {
    const attachment = inputValue?.privateAttachment;
    if (!isObject(attachment) || !only(attachment, ["schema", "handle", "manifest", "bytes_base64"])
      || attachment.schema !== "morrow.private-file-attachment.v1" || typeof attachment.handle !== "string" || !/^[A-Za-z0-9:_.-]{8,200}$/.test(attachment.handle)
      || typeof attachment.bytes_base64 !== "string" || attachment.bytes_base64.length < 4 || attachment.bytes_base64.length > 1_398_104) return null;
    const manifest = resourceFileManifest(attachment.manifest);
    if (!manifest || manifest.filename !== args.filename || manifest.size_bytes !== args.size_bytes || manifest.sha256 !== args.sha256) return null;
    let decoded;
    try {
      const binary = globalThis.atob(attachment.bytes_base64);
      decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch { return null; }
    if (decoded.byteLength !== manifest.size_bytes || decoded.byteLength < 1) return null;
    let sha256;
    try { sha256 = await bytesDigest(decoded); } catch { return null; }
    return sha256 === manifest.sha256 ? { manifest, bytes: decoded } : null;
  };
  const zipArchiveHasSingleRootManifest = (bytes) => {
    const MAX_ZIP_ENTRIES = 10_000;
    const MAX_ZIP_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
    const MAX_ZIP_COMPRESSION_RATIO = 200;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let index = bytes.byteLength - 22, minimum = Math.max(0, bytes.byteLength - 65_557); index >= minimum; index -= 1) {
      if (view.getUint32(index, true) === 0x06054b50) { eocd = index; break; }
    }
    if (eocd < 0 || eocd + 22 + view.getUint16(eocd + 20, true) !== bytes.byteLength
      || view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) return false;
    const entriesOnDisk = view.getUint16(eocd + 8, true);
    const entries = view.getUint16(eocd + 10, true);
    const centralSize = view.getUint32(eocd + 12, true);
    const centralOffset = view.getUint32(eocd + 16, true);
    if (entriesOnDisk !== entries || entries < 1 || entries > MAX_ZIP_ENTRIES
      || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
      || centralOffset + centralSize !== eocd) return false;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const names = new Set();
    const localOffsets = new Set();
    let manifestCount = 0;
    let totalUncompressed = 0;
    let offset = centralOffset;
    const centralEnd = centralOffset + centralSize;
    for (let index = 0; index < entries; index += 1) {
      if (offset + 46 > centralEnd || view.getUint32(offset, true) !== 0x02014b50) return false;
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const uncompressedSize = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const diskStart = view.getUint16(offset + 34, true);
      const localOffset = view.getUint32(offset + 42, true);
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if ((flags & 0x41) !== 0 || (method !== 0 && method !== 8) || diskStart !== 0 || localOffset === 0xffffffff
        || next > centralEnd || localOffset + 30 > centralOffset || localOffsets.has(localOffset)) return false;
      const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLength);
      let name;
      try { name = decoder.decode(nameBytes); } catch { return false; }
      const directory = name.endsWith("/");
      const parts = (directory ? name.slice(0, -1) : name).split("/");
      if (!name || name.includes("\u0000") || name.includes("\\") || name.startsWith("/") || !parts.length
        || parts.some((part) => !part || part === "." || part === "..") || names.has(name)) return false;
      if (view.getUint32(localOffset, true) !== 0x04034b50) return false;
      const localFlags = view.getUint16(localOffset + 6, true);
      const localMethod = view.getUint16(localOffset + 8, true);
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const localNameStart = localOffset + 30;
      const localDataStart = localNameStart + localNameLength + localExtraLength;
      if (localFlags !== flags || localMethod !== method || localDataStart > centralOffset
        || localNameLength !== nameLength || !bytes.slice(localNameStart, localNameStart + localNameLength).every((value, position) => value === nameBytes[position])
        || localDataStart + compressedSize > centralOffset) return false;
      if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES - uncompressedSize
        || uncompressedSize > Math.max(1, compressedSize) * MAX_ZIP_COMPRESSION_RATIO) return false;
      totalUncompressed += uncompressedSize;
      names.add(name);
      localOffsets.add(localOffset);
      if (!directory && name === "imsmanifest.xml") manifestCount += 1;
      offset = next;
    }
    return offset === centralEnd && manifestCount === 1;
  };
  const moduleFileManagerConfig = (documentValue, formData, module) => {
    const itemId = oneFormValue(formData, "files", 32);
    const inputs = documentValue.querySelectorAll('[data-fieldtype="filemanager"] input[type="hidden"][name="files"]');
    if (!draftItemId(itemId) || formData.getAll("files").length !== 1 || inputs.length !== 1 || !inputs[0].id
      || inputs[0].value !== itemId || documentValue.querySelectorAll(`[id="${CSS.escape(inputs[0].id)}"]`).length !== 1) return null;
    const configs = [];
    for (const script of documentValue.querySelectorAll("script:not([src])")) {
      const source = String(script.textContent || "");
      if (source.length > MAX_BYTES || source.includes("\u0000")) return null;
      const calls = /\bM\.form_filemanager\.init\s*\(/g;
      let call;
      while ((call = calls.exec(source))) {
        const comma = source.indexOf(",", calls.lastIndex);
        if (comma < calls.lastIndex) return null;
        const json = jsonObjectAt(source, comma + 1);
        if (!json) return null;
        let config;
        try { config = JSON.parse(json); } catch { return null; }
        if (!isObject(config)) return null;
        configs.push(config);
        calls.lastIndex = comma + json.length + 1;
      }
    }
    const matches = configs.filter((config) => config.target === inputs[0].id);
    if (matches.length !== 1) return null;
    const config = matches[0];
    const configItemId = id(config.itemid);
    const contextId = id(config.context?.id);
    const acceptedTypes = config.accepted_types === "*" || (Array.isArray(config.accepted_types) && config.accepted_types.length === 1 && config.accepted_types[0] === "*");
    const validLimit = (value) => Number.isSafeInteger(value) && value >= -1;
    const mainfileMatches = module === "resource" ? config.mainfile === true : (config.mainfile === "" || config.mainfile === false);
    const subdirsMatches = module === "resource" || config.subdirs === true || config.subdirs === 1;
    if (configItemId !== itemId || !contextId || !mainfileMatches || !subdirsMatches || config.maxfiles !== -1
      || !validLimit(config.maxbytes) || !validLimit(config.areamaxbytes) || !acceptedTypes
      || !isObject(config.filepicker) || !isObject(config.filepicker.repositories)) return null;
    const uploads = Object.entries(config.filepicker.repositories).filter(([key, repository]) => isObject(repository) && repository.type === "upload" && id(key) === id(repository.id));
    if (uploads.length !== 1 || !id(uploads[0][0]) || !id(uploads[0][1].id)) return null;
    const author = config.author === undefined ? null : typeof config.author === "string" && config.author.length <= 255 && !config.author.includes("\u0000") ? config.author : false;
    if (author === false) return null;
    return {
      itemId, contextId, repoId: id(uploads[0][1].id), author, maxBytes: config.maxbytes, areaMaxBytes: config.areamaxbytes, acceptedTypes: ["*"],
      semantic: { target: inputs[0].id, context_id: contextId, mainfile: module === "resource", subdirs: module === "folder", maxfiles: -1, maxbytes: config.maxbytes, areamaxbytes: config.areamaxbytes, accepted_types: "*", repo_id: id(uploads[0][1].id), author },
    };
  };
  const resourceFileManagerConfig = (documentValue, formData) => moduleFileManagerConfig(documentValue, formData, "resource");
  const folderFileManagerConfig = (documentValue, formData) => moduleFileManagerConfig(documentValue, formData, "folder");
  const imscpPackagePickerConfig = (documentValue, formData) => {
    const itemId = oneFormValue(formData, "package", 32);
    const inputs = documentValue.querySelectorAll('input.filepickerhidden[type="hidden"][name="package"]');
    if (!draftItemId(itemId) || formData.getAll("package").length !== 1 || inputs.length !== 1 || !inputs[0].id || inputs[0].value !== itemId) return null;
    const configs = [];
    for (const script of documentValue.querySelectorAll("script:not([src])")) {
      const source = String(script.textContent || "");
      if (source.length > MAX_BYTES || source.includes("\u0000")) return null;
      const calls = /\bM\.form_filepicker\.init\s*\(/g;
      let call;
      while ((call = calls.exec(source))) {
        const comma = source.indexOf(",", calls.lastIndex);
        if (comma < calls.lastIndex) return null;
        const json = jsonObjectAt(source, comma + 1);
        if (!json) return null;
        let config;
        try { config = JSON.parse(json); } catch { return null; }
        if (!isObject(config)) return null;
        configs.push(config);
        calls.lastIndex = comma + json.length + 1;
      }
    }
    const matches = configs.filter((config) => config.elementid === inputs[0].id);
    if (matches.length !== 1) return null;
    const config = matches[0];
    const contextId = id(config.context?.id);
    const accepted = Array.isArray(config.accepted_types) ? config.accepted_types : [];
    const acceptedTypes = accepted.filter((entry) => entry === ".zip" || entry === ".imscc");
    const validLimit = (value) => Number.isSafeInteger(value) && value >= -1;
    const uploads = isObject(config.repositories) ? Object.entries(config.repositories).filter(([key, repository]) => isObject(repository) && repository.type === "upload" && id(key) === id(repository.id)) : [];
    const author = config.author === undefined ? null : typeof config.author === "string" && config.author.length <= 255 && !config.author.includes("\u0000") ? config.author : false;
    if (id(config.itemid) !== itemId || !contextId || accepted.length !== 2 || acceptedTypes.length !== 2 || !validLimit(config.maxbytes)
      || uploads.length !== 1 || !id(uploads[0][0]) || !id(uploads[0][1].id) || author === false) return null;
    return { itemId, contextId, repoId: id(uploads[0][1].id), author, maxBytes: config.maxbytes, areaMaxBytes: -1, acceptedTypes,
      semantic: { target: inputs[0].id, context_id: contextId, maxbytes: config.maxbytes, accepted_types: acceptedTypes.slice().sort(), repo_id: id(uploads[0][1].id), author } };
  };
  const scormPackageFileManagerConfig = (documentValue, formData) => {
    const itemId = oneFormValue(formData, "packagefile", 32);
    const inputs = documentValue.querySelectorAll('[data-fieldtype="filemanager"] input[type="hidden"][name="packagefile"]');
    if (!draftItemId(itemId) || formData.getAll("packagefile").length !== 1 || inputs.length !== 1 || !inputs[0].id
      || inputs[0].value !== itemId || documentValue.querySelectorAll(`[id="${CSS.escape(inputs[0].id)}"]`).length !== 1) return null;
    const configs = [];
    for (const script of documentValue.querySelectorAll("script:not([src])")) {
      const source = String(script.textContent || "");
      if (source.length > MAX_BYTES || source.includes("\u0000")) return null;
      const calls = /\bM\.form_filemanager\.init\s*\(/g;
      let call;
      while ((call = calls.exec(source))) {
        const comma = source.indexOf(",", calls.lastIndex);
        if (comma < calls.lastIndex) return null;
        const json = jsonObjectAt(source, comma + 1);
        if (!json) return null;
        let config;
        try { config = JSON.parse(json); } catch { return null; }
        if (!isObject(config)) return null;
        configs.push(config);
        calls.lastIndex = comma + json.length + 1;
      }
    }
    const matches = configs.filter((config) => config.target === inputs[0].id);
    if (matches.length !== 1) return null;
    const config = matches[0];
    const accepted = Array.isArray(config.accepted_types) ? config.accepted_types : [];
    const acceptedTypes = accepted.filter((entry) => entry === ".zip" || entry === ".xml");
    const validLimit = (value) => Number.isSafeInteger(value) && value >= -1;
    const uploads = isObject(config.filepicker) && isObject(config.filepicker.repositories)
      ? Object.entries(config.filepicker.repositories).filter(([key, repository]) => isObject(repository) && repository.type === "upload" && id(key) === id(repository.id)) : [];
    const author = config.author === undefined ? null : typeof config.author === "string" && config.author.length <= 255 && !config.author.includes("\u0000") ? config.author : false;
    if (id(config.itemid) !== itemId || !id(config.context?.id) || accepted.length !== 2 || acceptedTypes.length !== 2
      || config.maxfiles !== 1 || (config.subdirs !== false && config.subdirs !== 0) || !validLimit(config.maxbytes)
      || uploads.length !== 1 || !id(uploads[0][0]) || !id(uploads[0][1].id) || author === false) return null;
    const contextId = id(config.context.id);
    return { itemId, contextId, repoId: id(uploads[0][1].id), author, maxBytes: config.maxbytes, areaMaxBytes: -1, acceptedTypes,
      semantic: { target: inputs[0].id, context_id: contextId, maxfiles: 1, subdirs: false, maxbytes: config.maxbytes, accepted_types: acceptedTypes.slice().sort(), repo_id: id(uploads[0][1].id), author } };
  };
  const resourceDraftListingMatches = (payload, manifest) => {
    if (!isObject(payload) || payload.filecount !== 1 || !Array.isArray(payload.list) || payload.list.length !== 1 || !isObject(payload.tree)
      || !Array.isArray(payload.tree.children) || payload.tree.children.length !== 0) return false;
    const file = payload.list[0];
    return isObject(file) && file.filepath === "/" && file.filename === manifest.filename && file.size === manifest.size_bytes
      && (file.type === "file" || file.type === "zip") && !Object.hasOwn(file, "source") && !Object.hasOwn(file, "repositorytype");
  };
  const nativeDraftUrl = (context, value, itemId, filename, filepath = "/") => {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.origin !== context.profile.origin || url.username || url.password || url.hash || url.protocol !== "https:") return null;
    const path = `${context.basePath}/draftfile.php`;
    const expected = `${filepath}${filename}`;
    if (url.pathname === path) {
      if ([...url.searchParams.keys()].length !== 1 || url.searchParams.getAll("file").length !== 1) return null;
      const parts = url.searchParams.get("file").split("/").filter(Boolean);
      return parts.length >= 5 && id(parts[0]) && parts[1] === "user" && parts[2] === "draft" && parts[3] === itemId
        && `/${parts.slice(4).join("/")}` === expected ? url.toString() : null;
    }
    const prefix = `${path}/`;
    const parts = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length).split("/") : [];
    let tail;
    try { tail = parts.slice(4).map((part) => decodeURIComponent(part)); } catch { return null; }
    return !url.search && parts.length >= 5 && id(parts[0]) && parts[1] === "user" && parts[2] === "draft" && parts[3] === itemId
      && `/${tail.join("/")}` === expected ? url.toString() : null;
  };
  const uploadResourceDraft = async (context, manager, manifest, bytes, module = "resource", savepath = "/") => {
    let file;
    try { file = new File([bytes], manifest.filename, { type: "application/octet-stream" }); } catch { return { ok: false, sent: false, error: "moodle_file_attachment_invalid" }; }
    const body = new FormData();
    body.append("repo_upload_file", file, manifest.filename);
    body.append("sesskey", context.sesskey);
    body.append("repo_id", manager.repoId);
    body.append("itemid", manager.itemId);
    body.append("savepath", savepath);
    body.append("title", manifest.filename);
    body.append("ctx_id", manager.contextId);
    for (const acceptedType of manager.acceptedTypes) body.append("accepted_types[]", acceptedType);
    if (manager.author !== null) body.append("author", manager.author);
    const endpoint = urlFor(context, "/repository/repository_ajax.php", { action: "upload" });
    let response;
    try { response = await fetch(endpoint, { method: "POST", credentials: "include", cache: "no-store", redirect: "error", headers: { Accept: "application/json" }, body }); } catch { return { ok: false, sent: true, outcomeUnknown: true, error: `moodle_${module}_draft_upload_unknown` }; }
    let text;
    try { text = await readText(response); } catch { return { ok: false, sent: true, outcomeUnknown: true, status: response.status, error: `moodle_${module}_draft_upload_unknown` }; }
    let result;
    try { result = JSON.parse(text); } catch { return { ok: false, sent: true, status: response.status, error: `moodle_${module}_draft_upload_refused` }; }
    if (!response.ok || !isObject(result) || result.error || result.fileexists || id(result.id) !== manager.itemId || result.file !== manifest.filename || typeof result.url !== "string") return { ok: false, sent: true, status: response.status, error: `moodle_${module}_draft_upload_refused` };
    const draftUrl = nativeDraftUrl(context, result.url, manager.itemId, manifest.filename, savepath);
    return draftUrl ? { ok: true, sent: true, status: response.status, draftUrl } : { ok: false, sent: true, status: response.status, error: `moodle_${module}_draft_upload_refused` };
  };
  // The staged draft copy is read back from Moodle before any save, so a save is never sent for
  // bytes Morrow has not seen in the draft area itself.
  const draftBytesMatch = async (context, draftUrl, manifest) => {
    let response;
    try { response = await fetch(draftUrl, { method: "GET", credentials: "include", cache: "no-store", redirect: "error" }); } catch { return false; }
    if (!response.ok || response.url !== draftUrl) return false;
    let bytes;
    try { bytes = await readLimitedBytes(response); } catch { return false; }
    if (bytes.byteLength !== manifest.size_bytes) return false;
    try { return await bytesDigest(bytes) === manifest.sha256; } catch { return false; }
  };
  const resourceFilesFromListing = (payload) => {
    if (!isObject(payload) || !Number.isSafeInteger(payload.filecount) || payload.filecount < 0 || payload.filecount > MAX_ITEMS || !Array.isArray(payload.list)
      || payload.list.length !== payload.filecount || !isObject(payload.tree) || !Array.isArray(payload.tree.children) || payload.tree.children.length !== 0) return null;
    const filenames = new Set();
    const files = [];
    for (const entry of payload.list) {
      const sortOrder = typeof entry?.sortorder === "string" && /^(0|[1-9][0-9]*)$/.test(entry.sortorder) ? Number(entry.sortorder) : entry?.sortorder;
      if (!isObject(entry) || entry.filepath !== "/" || (entry.type !== "file" && entry.type !== "zip") || !validResourceFilename(entry.filename)
        || filenames.has(entry.filename) || !Number.isSafeInteger(sortOrder) || sortOrder < 0) return null;
      const label = nativeText(entry.mimetype, 1333);
      if (!label || !label.trim()) return null;
      const size = entry.size === null ? 0 : entry.size;
      if (!Number.isSafeInteger(size) || size < 0) return null;
      filenames.add(entry.filename);
      files.push({ filename: entry.filename, relative_path: entry.filename, size_bytes: size, media_type_label: label, main_file: sortOrder === 1 });
    }
    if (files.length > 0 && files.filter((file) => file.main_file).length !== 1) return null;
    return files.sort((left, right) => left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0);
  };
  const folderPath = (value) => {
    if (typeof value !== "string" || !value.startsWith("/") || !value.endsWith("/") || value.length > 4096 || value.includes("\u0000")) return null;
    const parts = value.split("/").filter(Boolean);
    // The root of a Folder file area is "/", so an empty part list keeps one separator, not two.
    return parts.every(validResourceFilename) ? `/${parts.map((part) => `${part}/`).join("")}` : null;
  };
  const folderPathsFromTree = (tree) => {
    if (!isObject(tree)) return null;
    const paths = new Set(["/"]);
    const visit = (node, parent) => {
      if (!isObject(node) || node.children === undefined) return node && node.children === undefined;
      if (!Array.isArray(node.children)) return false;
      for (const child of node.children) {
        if (!isObject(child)) return false;
        const childPath = folderPath(child.filepath);
        if (!childPath || !childPath.startsWith(parent) || childPath === parent || paths.has(childPath)) return false;
        paths.add(childPath);
        if (!visit(child, childPath)) return false;
      }
      return true;
    };
    return visit(tree, "/") ? [...paths].sort() : null;
  };
  const folderFilesFromListing = async (context, itemId, root) => {
    if (!isObject(root) || !Number.isSafeInteger(root.filecount) || root.filecount < 0 || root.filecount > 10_000) return null;
    const paths = folderPathsFromTree(root.tree);
    if (!paths) return null;
    const files = [];
    const seen = new Set();
    for (const filepath of paths) {
      const listing = filepath === "/" ? root : await readDraftListing(context, itemId, filepath);
      if (!isObject(listing) || listing.filecount !== root.filecount || !Array.isArray(listing.list)) return null;
      const currentPaths = folderPathsFromTree(listing.tree);
      if (!currentPaths || stable(currentPaths) !== stable(paths)) return null;
      for (const entry of listing.list) {
        if (!isObject(entry)) return null;
        if (entry.type === "folder") {
          const childPath = folderPath(entry.filepath);
          if (!childPath || !childPath.startsWith(filepath) || childPath === filepath || !paths.includes(childPath)) return null;
          continue;
        }
        if (entry.filepath !== filepath || (entry.type !== "file" && entry.type !== "zip") || !validResourceFilename(entry.filename)) return null;
        const label = nativeText(entry.mimetype, 1333);
        const size = entry.size === null ? 0 : entry.size;
        if (!label || !label.trim() || !Number.isSafeInteger(size) || size < 0) return null;
        const relativePath = `${filepath.slice(1)}${entry.filename}`;
        if (seen.has(relativePath)) return null;
        seen.add(relativePath);
        files.push({ filename: entry.filename, relative_path: relativePath, size_bytes: size, media_type_label: label });
        if (files.length > 10_000) return null;
      }
    }
    if (files.length !== root.filecount) return null;
    return files.sort((left, right) => left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0);
  };
  // One reading of an exact Resource or Folder: the native settings form, its private draft
  // listing, and the digest that a later file change must present. Every file write below plans
  // against this reading and compares the saved result against it again.
  const moduleFilesSnapshot = async (context, args, module, kind, bound) => {
    const form = await loadForm(context, formDescriptor(context, kind, args));
    if (!form.ok) return form;
    const name = oneFormValue(form.formData, "name", 1333);
    const draftId = oneFormValue(form.formData, "files", 32);
    const managers = form.fileManagers.filter((entry) => entry.name === "files");
    const filesManager = managers.length === 1 ? managers[0] : null;
    if (!name || name !== bound.name || !draftItemId(draftId) || !filesManager || form.formData.getAll("files").length !== 1) return error(`moodle_${module}_files_target_invalid`);
    const files = module === "resource" ? resourceFilesFromListing(filesManager.listing) : await folderFilesFromListing(context, draftId, filesManager.listing);
    const paths = module === "folder" ? folderPathsFromTree(filesManager.listing?.tree) : ["/"];
    if (!files || !paths) return error(`moodle_${module}_files_listing_refused`);
    const data = {
      course_id: Number(args.course_id), module_id: Number(args.module_id), name: bound.name, files,
      provenance: { source: `native_${module}_settings_form`, private_draft_copy_prepared: true, form_submitted: false, ...(module === "resource" ? { root_folder_only: true } : { recursive_folder_listing: true }) },
    };
    return { ok: true, sent: true, status: form.status, bound, form, draftId, files, paths, data, snapshot_digest: await digest(data) };
  };
  const moduleFileTargets = (context, bound, module) => [
    courseTarget(context, bound.course.fullname || bound.course.name),
    { field: "module_id", label: module === "resource" ? "Resource" : "Folder", name: bound.name },
  ];
  const getModuleFiles = async (context, inputValue, args, module) => {
    const bound = await moduleFileBinding(context, args, module);
    if (!bound.ok) return bound;
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const snapshot = await moduleFilesSnapshot(rechecked, args, module, `${module}-files-read`, bound);
    if (!snapshot.ok) return snapshot;
    return { ok: true, sent: true, status: snapshot.status, data: snapshot.data, targets: moduleFileTargets(rechecked, bound, module), snapshot_digest: snapshot.snapshot_digest };
  };
  const getResourceFiles = async (context, inputValue, args) => getModuleFiles(context, inputValue, args, "resource");
  const getFolderFiles = async (context, inputValue, args) => getModuleFiles(context, inputValue, args, "folder");
  const loadModuleFileCreationForm = async (context, args, module) => {
    const selected = await selectedSection(context, args.course_id, args.section_id);
    if (!selected.ok) return selected;
    const creationKind = module === "imscp" ? "imscp-package-create-form-read" : module === "scorm" ? "scorm-package-create-form-read" : `${module}-file-create-form-read`;
    const descriptor = formDescriptor(context, creationKind, {
      ...args, section_number: sectionNumber(selected.section.number), section_name: sectionTarget(selected.section).name,
    });
    const form = await loadForm(context, descriptor);
    if (!form.ok) return form;
    const manager = module === "resource" ? resourceFileManagerConfig(form.document, form.formData) : module === "folder" ? folderFileManagerConfig(form.document, form.formData) : module === "imscp" ? imscpPackagePickerConfig(form.document, form.formData) : scormPackageFileManagerConfig(form.document, form.formData);
    const packageModule = module === "imscp" || module === "scorm";
    const field = module === "imscp" ? "package" : module === "scorm" ? "packagefile" : "files";
    const filesManager = packageModule && manager ? await readDraftListing(context, manager.itemId) : form.fileManagers.length >= 1 ? form.fileManagers.find((entry) => entry.name === field) : null;
    const empty = packageModule
      ? isObject(filesManager) && filesManager.filecount === 0 && Array.isArray(filesManager.list) && filesManager.list.length === 0
      : filesManager?.state === "empty" && form.fileManagers.filter((entry) => entry.name === field).length === 1 && form.fileManagers.every((entry) => entry.state === "empty");
    if (!manager || !empty || !form.submit || form.submit.name !== "submitbutton2"
      || (module !== "scorm" && oneFormValue(form.formData, "revision", 32) === "") || !draftItemId(manager.itemId)
      || (module === "scorm" && (oneFormValue(form.formData, "scormtype", 32) !== "local" || oneFormValue(form.formData, "updatefreq", 32) !== "0"))) return { ...error(`moodle_${module}_creation_form_invalid`), status: form.status };
    const data = { course_id: Number(args.course_id), section_id: Number(args.section_id), name: one(form.values, "name"), visible: one(form.values, "visible") === "1" };
    return { ...form, section: selected.section, manager, fileField: field, data, snapshot_digest: await digest({ values: form.values, manager: manager.semantic }) };
  };
  const loadResourceFileCreationForm = async (context, args) => loadModuleFileCreationForm(context, args, "resource");
  const loadFolderFileCreationForm = async (context, args) => loadModuleFileCreationForm(context, args, "folder");
  const loadImscpPackageCreationForm = async (context, args) => loadModuleFileCreationForm(context, args, "imscp");
  const loadScormPackageCreationForm = async (context, args) => loadModuleFileCreationForm(context, args, "scorm");
  const resourceResult = async (ok, status, data, targets, reason = "") => ({
    ok, sent: true, status, data, targets, snapshot_digest: await digest(data), verification: { schema: "morrow.browser-verification.v1", status: ok ? "verified" : "mismatch", ...(ok ? {} : { reason }) }, ...(ok ? {} : { error: "moodle_write_not_verified" }),
  });
  const unconfirmedResourceCreate = (status, reason) => ({ ok: false, sent: true, status, outcomeUnknown: true, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason }, error: reason });
  // One native POST with Save and return to course, for both the creation form and the saved
  // settings form of an existing Resource or Folder. It never follows a module view route, and a
  // response it cannot read stays unconfirmed rather than being sent again.
  const postModuleFileForm = async (context, form, module, overrides, invalidError) => {
    if (!sameContext(form.context, currentContext())) return error("moodle_binding_mismatch");
    if (!form.submit || form.submit.name !== "submitbutton2" || !draftItemId(form.manager.itemId)) return error(invalidError);
    const params = new URLSearchParams();
    try {
      for (const [name, value] of form.formData.entries()) {
        if (name === "coursecontentnotification" || name === "submitbutton" || name === "submitbutton2") continue;
        if (typeof value !== "string") return error(invalidError);
        params.append(name, value);
      }
    } catch { return error(invalidError); }
    for (const [name, value] of Object.entries(overrides)) params.set(name, value);
    params.set("submitbutton2", form.submit.value);
    let response;
    try { response = await fetch(form.action, { method: "POST", credentials: "include", cache: "no-store", redirect: "follow", headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: params }); } catch { return unconfirmedResourceCreate(undefined, `moodle_${module}_save_unknown`); }
    let text;
    try { text = await readText(response); } catch { return unconfirmedResourceCreate(response.status, `moodle_${module}_save_unknown`); }
    if (!response.ok) return unconfirmedResourceCreate(response.status, `moodle_${module}_save_unknown`);
    if (!response.redirected && isSameFormValidation(text, form)) return { ok: false, sent: true, status: response.status, verification: { schema: "morrow.browser-verification.v1", status: "mismatch", reason: `moodle_${module}_save_not_sent` }, error: `moodle_${module}_save_not_sent` };
    let finalUrl; let actionUrl;
    try { finalUrl = new URL(response.url || form.action); actionUrl = new URL(form.action); } catch { return unconfirmedResourceCreate(response.status, `moodle_${module}_save_unknown`); }
    if (!response.redirected || finalUrl.origin !== context.profile.origin || finalUrl.pathname === actionUrl.pathname) return unconfirmedResourceCreate(response.status, `moodle_${module}_save_unknown`);
    return { ok: true, sent: true, status: response.status };
  };
  const getModulePluginfile = async (context, manager, revision, manifest, module, filepath = "/") => {
    const area = module === "imscp" ? "backup" : module === "scorm" ? "package" : "content";
    const revisionPath = module === "scorm" ? "" : `/${revision}`;
    const directory = filepath.split("/").filter(Boolean).map((part) => `${encodeURIComponent(part)}/`).join("");
    const endpoint = urlFor(context, `/pluginfile.php/${manager.contextId}/mod_${module}/${area}${revisionPath}/${directory}${encodeURIComponent(manifest.filename)}`, { forcedownload: 1 });
    let response;
    try { response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "error" }); } catch { return null; }
    let bytes;
    try { bytes = await readLimitedBytes(response); } catch { return null; }
    if (!response.ok || response.url !== endpoint || bytes.byteLength !== manifest.size_bytes) return null;
    try { return await bytesDigest(bytes) === manifest.sha256 ? bytes : null; } catch { return null; }
  };
  const runModuleFileCreation = async (context, inputValue, args, module) => {
    const prepared = await loadModuleFileCreationForm(context, args, module);
    if (!prepared.ok) return prepared;
    if (prepared.snapshot_digest !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    const local = await exactPrivateResourceFile(inputValue, args);
    if (!local) return error("moodle_file_attachment_invalid");
    if ((module === "imscp" || module === "scorm") && !zipArchiveHasSingleRootManifest(local.bytes)) return error(`moodle_${module}_package_manifest_invalid`);
    if ([prepared.manager.maxBytes, prepared.manager.areaMaxBytes].some((limit) => limit > 0 && local.manifest.size_bytes > limit)) return error("moodle_file_exceeds_native_limit");
    const before = await state(context, args.course_id);
    if (!before.ok) return before;
    const beforeIds = new Set(before.data.cm.map((entry) => id(entry?.id)).filter(Boolean));
    const current = currentContext();
    if (!sameContext(context, current) || validateBinding(current, inputValue.binding)) return error("moodle_binding_mismatch");
    const preflight = await loadModuleFileCreationForm(current, args, module);
    if (!preflight.ok) return preflight;
    if (prepared.action !== preflight.action || prepared.nativeSesskey !== preflight.nativeSesskey
      || prepared.snapshot_digest !== preflight.snapshot_digest || stable(prepared.manager.semantic) !== stable(preflight.manager.semantic)
      || sectionNumber(prepared.section.number) !== sectionNumber(preflight.section.number)) return error(`moodle_${module}_creation_form_changed`);
    const uploaded = await uploadResourceDraft(current, prepared.manager, local.manifest, local.bytes, module);
    if (!uploaded.ok) return { ...uploaded, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: uploaded.error } };
    const listing = await readDraftListing(current, prepared.manager.itemId);
    if (!resourceDraftListingMatches(listing, local.manifest)) return { ok: false, sent: true, status: uploaded.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: `moodle_${module}_upload_succeeded_save_not_sent` }, error: `moodle_${module}_upload_succeeded_save_not_sent` };
    if (!await draftBytesMatch(current, uploaded.draftUrl, local.manifest)) return { ok: false, sent: true, status: uploaded.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: `moodle_${module}_upload_succeeded_save_not_sent` }, error: `moodle_${module}_upload_succeeded_save_not_sent` };
    const saveContext = currentContext();
    if (!sameContext(current, saveContext) || validateBinding(saveContext, inputValue.binding)) return error("moodle_binding_mismatch");
    const selected = await selectedSection(saveContext, args.course_id, args.section_id);
    if (!selected.ok || sectionNumber(selected.section.number) !== prepared.descriptor.sectionNumber) return error("moodle_section_target_invalid");
    const saved = await postModuleFileForm(saveContext, prepared, module, { name: args.name, visible: "0", [prepared.fileField || "files"]: prepared.manager.itemId }, `moodle_${module}_creation_form_invalid`);
    if (!saved.ok) return saved;
    const after = await state(saveContext, args.course_id);
    if (!after.ok) return unconfirmedResourceCreate(saved.status, `moodle_${module}_readback_unconfirmed`);
    const activities = after.data.cm.filter((entry) => !beforeIds.has(id(entry?.id)) && entry?.module === module && entry?.name === args.name
      && id(entry?.sectionid) === args.section_id && entry?.visible === false);
    if (activities.length !== 1 || !id(activities[0]?.id)) return unconfirmedResourceCreate(saved.status, `moodle_${module}_readback_unconfirmed`);
    const moduleId = id(activities[0].id);
    const savedForm = await loadForm(saveContext, formDescriptor(saveContext, module === "imscp" ? "imscp-form-read" : module === "scorm" ? "scorm-form-read" : `${module}-files-read`, { course_id: args.course_id, module_id: moduleId }));
    if (!savedForm.ok) return unconfirmedResourceCreate(saved.status, `moodle_${module}_readback_unconfirmed`);
    const manager = module === "resource" ? resourceFileManagerConfig(savedForm.document, savedForm.formData) : module === "folder" ? folderFileManagerConfig(savedForm.document, savedForm.formData) : module === "imscp" ? imscpPackagePickerConfig(savedForm.document, savedForm.formData) : scormPackageFileManagerConfig(savedForm.document, savedForm.formData);
    const field = module === "imscp" ? "package" : module === "scorm" ? "packagefile" : "files";
    const managers = savedForm.fileManagers.filter((entry) => entry.name === field);
    const listingManager = managers.length === 1 && savedForm.fileManagers.every((entry) => entry.name === field || entry.state === "empty") ? managers[0] : null;
    const files = listingManager ? (module === "folder" ? await folderFilesFromListing(saveContext, manager?.itemId || "", listingManager.listing) : resourceFilesFromListing(listingManager.listing)) : module === "imscp" ? [] : null;
    const revision = oneFormValue(savedForm.formData, "revision", 32);
    const expectedRootFile = module === "imscp" || (files?.length === 1 && files[0].filename === local.manifest.filename && files[0].relative_path === local.manifest.filename && files[0].size_bytes === local.manifest.size_bytes
      && (module !== "resource" || files[0].main_file));
    if (!manager || (module !== "scorm" && !draftItemId(revision)) || oneFormValue(savedForm.formData, "name", 1333) !== args.name || one(savedForm.values, "visible") !== "0" || !expectedRootFile
      || (module === "scorm" && (oneFormValue(savedForm.formData, "scormtype", 32) !== "local" || oneFormValue(savedForm.formData, "updatefreq", 32) !== "0"))) {
      const data = { course_id: Number(args.course_id), section_id: Number(args.section_id), module_id: Number(moduleId), name: args.name, visible: false, file: local.manifest };
      return resourceResult(false, saved.status, data, [courseTarget(saveContext), sectionTarget(selected.section)], `moodle_${module}_readback_mismatch`);
    }
    const savedBytes = await getModulePluginfile(saveContext, manager, revision, local.manifest, module);
    const data = { course_id: Number(args.course_id), section_id: Number(args.section_id), module_id: Number(moduleId), name: args.name, visible: false, file: local.manifest };
    return resourceResult(Boolean(savedBytes), saved.status, data, [courseTarget(saveContext), sectionTarget(selected.section)], `moodle_${module}_saved_bytes_mismatch`);
  };
  const runResourceFileCreation = async (context, inputValue, args) => runModuleFileCreation(context, inputValue, args, "resource");
  const runFolderFileCreation = async (context, inputValue, args) => runModuleFileCreation(context, inputValue, args, "folder");
  const runImscpPackageCreation = async (context, inputValue, args) => runModuleFileCreation(context, inputValue, args, "imscp");
  const runScormPackageCreation = async (context, inputValue, args) => runModuleFileCreation(context, inputValue, args, "scorm");
  // Every file change below plans against one reading of the exact activity, stages each reviewed
  // file in Moodle's own private draft area, compares the staged bytes there, sends one native
  // save, and compares the saved bytes again. An uncertain upload stops before the save. An
  // uncertain save stays unconfirmed. Neither is sent a second time.
  const moduleFileEditPreflight = async (context, inputValue, args, module, kind) => {
    const bound = await moduleFileBinding(context, args, module);
    if (!bound.ok) return bound;
    const current = currentContext();
    if (!sameContext(context, current) || validateBinding(current, inputValue.binding)) return error("moodle_binding_mismatch");
    const snapshot = await moduleFilesSnapshot(current, args, module, kind, bound);
    if (!snapshot.ok) return snapshot;
    if (snapshot.snapshot_digest !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    const manager = module === "resource" ? resourceFileManagerConfig(snapshot.form.document, snapshot.form.formData) : folderFileManagerConfig(snapshot.form.document, snapshot.form.formData);
    if (!manager || manager.itemId !== snapshot.draftId || !snapshot.form.submit || snapshot.form.submit.name !== "submitbutton2") return error(`moodle_${module}_files_target_invalid`);
    return { ...snapshot, context: current, manager, form: { ...snapshot.form, manager } };
  };
  const nativeLimitExceeded = (manager, sizes, keptBytes = 0) => {
    const total = sizes.reduce((sum, size) => sum + size, keptBytes);
    return sizes.some((size) => manager.maxBytes > 0 && size > manager.maxBytes) || (manager.areaMaxBytes > 0 && total > manager.areaMaxBytes);
  };
  const draftFileEntries = (listing, filepath) => (isObject(listing) && Array.isArray(listing.list) ? listing.list : [])
    .filter((entry) => isObject(entry) && entry.type !== "folder" && entry.filepath === filepath);
  const removeDraftFile = async (context, itemId, filepath, filename) => {
    const removed = await draftFilesAction(context, "delete", { itemid: itemId, filepath, filename });
    if (!isObject(removed) || removed.filepath !== filepath) return false;
    const listing = await readDraftListing(context, itemId, filepath);
    return isObject(listing) && Array.isArray(listing.list)
      && draftFileEntries(listing, filepath).every((entry) => entry.filename !== filename);
  };
  const unconfirmedStage = (status, reason) => ({ ok: false, sent: true, status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason }, error: reason });
  const stageDraftFiles = async (context, manager, entries, module) => {
    let status;
    for (const entry of entries) {
      const uploaded = await uploadResourceDraft(context, manager, entry.manifest, entry.bytes, module, entry.filepath);
      status = uploaded.status ?? status;
      if (!uploaded.ok) return { ...uploaded, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: uploaded.error } };
      const listed = draftFileEntries(await readDraftListing(context, manager.itemId, entry.filepath), entry.filepath)
        .filter((file) => file.filename === entry.manifest.filename);
      const staged = listed.length === 1 && listed[0].size === entry.manifest.size_bytes
        && await draftBytesMatch(context, uploaded.draftUrl, entry.manifest);
      if (!staged) return unconfirmedStage(status, `moodle_${module}_upload_succeeded_save_not_sent`);
    }
    return { ok: true, sent: true, status };
  };
  const savedModuleFiles = async (context, args, module, kind) => {
    const bound = await moduleFileBinding(context, args, module);
    if (!bound.ok) return null;
    const snapshot = await moduleFilesSnapshot(context, args, module, kind, bound);
    if (!snapshot.ok) return null;
    const manager = module === "resource" ? resourceFileManagerConfig(snapshot.form.document, snapshot.form.formData) : folderFileManagerConfig(snapshot.form.document, snapshot.form.formData);
    const revision = oneFormValue(snapshot.form.formData, "revision", 32);
    return manager && draftItemId(revision) ? { ...snapshot, manager, revision } : null;
  };
  const fileSummary = (files) => stable(files.map((file) => ({ relative_path: file.relative_path, size_bytes: file.size_bytes, ...(Object.hasOwn(file, "main_file") ? { main_file: file.main_file } : {}) })));
  const moduleFileResult = async (ok, status, saveContext, args, module, bound, files, reason) => {
    const data = { course_id: Number(args.course_id), module_id: Number(args.module_id), name: bound.name, files };
    return { ok, sent: true, status, data, targets: moduleFileTargets(saveContext, bound, module), snapshot_digest: await digest(data), verification: { schema: "morrow.browser-verification.v1", status: ok ? "verified" : "mismatch", ...(ok ? {} : { reason }) }, ...(ok ? {} : { error: "moodle_write_not_verified" }) };
  };
  const runResourceFileReplace = async (context, inputValue, args) => {
    const local = await exactPrivateResourceFile(inputValue, args);
    if (!local) return error("moodle_file_attachment_invalid");
    const prepared = await moduleFileEditPreflight(context, inputValue, args, "resource", "resource-file-replace");
    if (!prepared.ok) return prepared;
    const replaced = prepared.files.length === 1 && prepared.files[0].main_file ? prepared.files[0] : null;
    if (!replaced) return { ...error("moodle_resource_file_replace_target_invalid"), status: prepared.status };
    if (nativeLimitExceeded(prepared.manager, [local.manifest.size_bytes])) return { ...error("moodle_file_exceeds_native_limit"), status: prepared.status };
    if (!await removeDraftFile(prepared.context, prepared.draftId, "/", replaced.filename)) return { ...error("moodle_resource_file_area_not_cleared"), status: prepared.status };
    const staged = await stageDraftFiles(prepared.context, prepared.manager, [{ manifest: local.manifest, bytes: local.bytes, filepath: "/" }], "resource");
    if (!staged.ok) return staged;
    const saveContext = currentContext();
    if (!sameContext(prepared.context, saveContext) || validateBinding(saveContext, inputValue.binding)) return error("moodle_binding_mismatch");
    const saved = await postModuleFileForm(saveContext, prepared.form, "resource", { files: prepared.manager.itemId }, "moodle_resource_files_target_invalid");
    if (!saved.ok) return saved;
    const after = await savedModuleFiles(saveContext, args, "resource", "resource-files-read");
    if (!after) return unconfirmedResourceCreate(saved.status, "moodle_resource_readback_unconfirmed");
    const expected = [{ filename: local.manifest.filename, relative_path: local.manifest.filename, size_bytes: local.manifest.size_bytes, main_file: true }];
    const listingMatches = fileSummary(after.files) === fileSummary(expected) && after.files[0]?.filename === local.manifest.filename;
    const savedBytes = listingMatches && await getModulePluginfile(saveContext, after.manager, after.revision, local.manifest, "resource");
    return moduleFileResult(Boolean(savedBytes), saved.status, saveContext, args, "resource", after.bound, after.files, listingMatches ? "moodle_resource_saved_bytes_mismatch" : "moodle_resource_readback_mismatch");
  };
  const runResourceFileDelete = async (context, inputValue, args) => {
    if (inputValue?.privateAttachment !== undefined || inputValue?.privateAttachments !== undefined) return error("moodle_arguments_invalid");
    const prepared = await moduleFileEditPreflight(context, inputValue, args, "resource", "resource-file-delete");
    if (!prepared.ok) return prepared;
    const removed = prepared.files.find((file) => file.filename === args.filename);
    // A Resource must keep a main file, so only an additional root file can be removed here.
    if (!removed || removed.main_file || prepared.files.length < 2) return { ...error("moodle_resource_file_delete_target_invalid"), status: prepared.status };
    const remaining = prepared.files.filter((file) => file.filename !== args.filename);
    if (!await removeDraftFile(prepared.context, prepared.draftId, "/", args.filename)) return { ...error("moodle_resource_file_area_not_cleared"), status: prepared.status };
    const saveContext = currentContext();
    if (!sameContext(prepared.context, saveContext) || validateBinding(saveContext, inputValue.binding)) return error("moodle_binding_mismatch");
    const saved = await postModuleFileForm(saveContext, prepared.form, "resource", { files: prepared.manager.itemId }, "moodle_resource_files_target_invalid");
    if (!saved.ok) return saved;
    const after = await savedModuleFiles(saveContext, args, "resource", "resource-files-read");
    if (!after) return unconfirmedResourceCreate(saved.status, "moodle_resource_readback_unconfirmed");
    const matches = fileSummary(after.files) === fileSummary(remaining) && after.files.every((file) => file.filename !== args.filename);
    return moduleFileResult(matches, saved.status, saveContext, args, "resource", after.bound, after.files, "moodle_resource_readback_mismatch");
  };
  const exactPrivateFolderFiles = async (inputValue, args) => {
    const attachments = inputValue?.privateAttachments;
    if (inputValue?.privateAttachment !== undefined || !Array.isArray(attachments) || attachments.length !== args.files.length) return null;
    const resolved = [];
    for (let index = 0; index < attachments.length; index += 1) {
      const file = await exactPrivateResourceFile({ privateAttachment: attachments[index] }, args.files[index]);
      if (!file) return null;
      resolved.push({ manifest: file.manifest, bytes: file.bytes, filepath: args.folder_path });
    }
    return resolved;
  };
  const runFolderFilesAdd = async (context, inputValue, args) => {
    const staged = await exactPrivateFolderFiles(inputValue, args);
    if (!staged) return error("moodle_file_attachment_invalid");
    const prepared = await moduleFileEditPreflight(context, inputValue, args, "folder", "folder-files-add");
    if (!prepared.ok) return prepared;
    if (!prepared.paths.includes(args.folder_path)) return { ...error("moodle_folder_path_invalid"), status: prepared.status };
    const added = staged.map((entry) => ({ filename: entry.manifest.filename, relative_path: `${args.folder_path.slice(1)}${entry.manifest.filename}`, size_bytes: entry.manifest.size_bytes }));
    if (added.some((file) => prepared.files.some((existing) => existing.relative_path === file.relative_path))) return { ...error("moodle_folder_file_exists"), status: prepared.status };
    const keptBytes = prepared.files.reduce((sum, file) => sum + file.size_bytes, 0);
    if (nativeLimitExceeded(prepared.manager, staged.map((entry) => entry.manifest.size_bytes), keptBytes)) return { ...error("moodle_file_exceeds_native_limit"), status: prepared.status };
    const uploaded = await stageDraftFiles(prepared.context, prepared.manager, staged, "folder");
    if (!uploaded.ok) return uploaded;
    const saveContext = currentContext();
    if (!sameContext(prepared.context, saveContext) || validateBinding(saveContext, inputValue.binding)) return error("moodle_binding_mismatch");
    const saved = await postModuleFileForm(saveContext, prepared.form, "folder", { files: prepared.manager.itemId }, "moodle_folder_files_target_invalid");
    if (!saved.ok) return saved;
    const after = await savedModuleFiles(saveContext, args, "folder", "folder-files-read");
    if (!after) return unconfirmedResourceCreate(saved.status, "moodle_folder_readback_unconfirmed");
    const expected = [...prepared.files, ...added].sort((left, right) => left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0);
    const listingMatches = fileSummary(after.files) === fileSummary(expected);
    let matches = listingMatches;
    for (const entry of staged) {
      if (!matches) break;
      matches = Boolean(await getModulePluginfile(saveContext, after.manager, after.revision, entry.manifest, "folder", entry.filepath));
    }
    return moduleFileResult(matches, saved.status, saveContext, args, "folder", after.bound, after.files, listingMatches ? "moodle_folder_saved_bytes_mismatch" : "moodle_folder_readback_mismatch");
  };
  const runFolderSubfolderCreate = async (context, inputValue, args) => {
    if (inputValue?.privateAttachment !== undefined || inputValue?.privateAttachments !== undefined) return error("moodle_arguments_invalid");
    const prepared = await moduleFileEditPreflight(context, inputValue, args, "folder", "folder-subfolder-create");
    if (!prepared.ok) return prepared;
    const created = `${args.parent_path}${args.name}/`;
    if (!prepared.paths.includes(args.parent_path) || prepared.paths.includes(created)) return { ...error("moodle_folder_path_invalid"), status: prepared.status };
    const made = await draftFilesAction(prepared.context, "mkdir", { itemid: prepared.draftId, filepath: args.parent_path, newdirname: args.name });
    if (!isObject(made) || made.filepath !== args.parent_path) return { ...error("moodle_folder_subfolder_not_created"), status: prepared.status };
    const staged = folderPathsFromTree((await readDraftListing(prepared.context, prepared.draftId))?.tree);
    if (!staged || stable(staged) !== stable([...prepared.paths, created].sort())) return { ...error("moodle_folder_subfolder_not_created"), status: prepared.status };
    const saveContext = currentContext();
    if (!sameContext(prepared.context, saveContext) || validateBinding(saveContext, inputValue.binding)) return error("moodle_binding_mismatch");
    const saved = await postModuleFileForm(saveContext, prepared.form, "folder", { files: prepared.manager.itemId }, "moodle_folder_files_target_invalid");
    if (!saved.ok) return saved;
    const after = await savedModuleFiles(saveContext, args, "folder", "folder-files-read");
    if (!after) return unconfirmedResourceCreate(saved.status, "moodle_folder_readback_unconfirmed");
    const matches = after.paths.includes(created) && fileSummary(after.files) === fileSummary(prepared.files);
    const data = { course_id: Number(args.course_id), module_id: Number(args.module_id), name: after.bound.name, folder_path: created, files: after.files };
    return { ok: matches, sent: true, status: saved.status, data, targets: moduleFileTargets(saveContext, after.bound, "folder"), snapshot_digest: await digest(data), verification: { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_folder_readback_mismatch" }) }, ...(matches ? {} : { error: "moodle_write_not_verified" }) };
  };
  const slotName = (node) => String(node.querySelector(".instancename")?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 1333);
  const parseQuizSlots = (context, documentValue, moduleId) => {
    const roots = Array.from(documentValue.querySelectorAll('ul.slots[role="presentation"]'));
    if (roots.length !== 1) return null;
    const sections = Array.from(roots[0].children).filter((node) => node.matches?.('li.section.main[id^="section-"]'));
    if (!sections.length) return null;
    const slotLists = sections.map((section) => Array.from(section.querySelectorAll("ul.section.img-text")));
    if (slotLists.some((lists) => lists.length !== 1)) return null;
    const nodes = slotLists.flatMap((lists) => Array.from(lists[0].querySelectorAll(':scope > li.slot[id^="slot-"]')));
    const quizEndpoint = urlFor(context, "/mod/quiz/edit.php", { cmid: moduleId });
    const seen = new Set();
    const slots = [];
    for (const node of nodes.slice(0, MAX_ITEMS)) {
      const slotId = id(String(node.getAttribute("id") || "").slice("slot-".length));
      const qtypeClass = Array.from(node.classList).find((name) => name.startsWith("qtype_"));
      const qtype = qtypeClass && /^[a-z][a-z0-9_]*$/.test(qtypeClass.slice("qtype_".length)) ? qtypeClass.slice("qtype_".length) : "";
      if (!slotId || !qtype || seen.has(slotId)) return null;
      seen.add(slotId);
      const random = node.classList.contains("random") || qtype === "random";
      let version = null;
      if (!random) {
        const selects = Array.from(node.querySelectorAll(`select.version-selection[data-slot-id="${slotId}"]`));
        if (selects.length !== 1) return null;
        const selected = Array.from(selects[0].querySelectorAll("option[selected]")).filter((option) => id(option.getAttribute("value")) || option.getAttribute("value") === "0");
        if (selected.length !== 1) return null;
        const value = selected[0].getAttribute("value");
        version = value === "0" ? { mode: "latest" } : id(value) ? { mode: "pinned", number: Number(id(value)) } : null;
        if (!version) return null;
      }
      let questionId = "";
      let malformedLink = false;
      const questionLinks = [];
      for (const anchor of node.querySelectorAll("a[href]")) {
        let href;
        try { href = new URL(anchor.getAttribute("href"), quizEndpoint); } catch { continue; }
        const expectedPath = `${context.basePath}/question/bank/editquestion/question.php`;
        if (href.origin !== context.profile.origin || href.pathname !== expectedPath) continue;
        const candidateId = id(href.searchParams.get("id"));
        if (href.searchParams.getAll("id").length !== 1 || href.searchParams.getAll("cmid").length !== 1 || !candidateId || href.searchParams.get("cmid") !== moduleId) questionLinks.push({ invalid: true });
        else questionLinks.push({ questionId: candidateId });
      }
      if (questionLinks.length > 1 || questionLinks.some((entry) => entry.invalid)) malformedLink = true;
      if (malformedLink) return null;
      if (questionLinks.length === 1) questionId = questionLinks[0].questionId;
      const marks = Array.from(node.querySelectorAll(".instancemaxmark"));
      if (marks.length !== 1) return null;
      const maxMarkText = nativeText(marks[0].textContent || "", 64)?.replace(/\s+/g, " ").trim() || "";
      if (maxMarkText && !/^[0-9]+(?:[.,][0-9]+)?$/.test(maxMarkText)) return null;
      const supported = supportedQuestionTypes.has(qtype);
      const reason = random ? "random_slot" : !supported ? "unsupported_type" : !questionId ? "not_editable" : "";
      slots.push({
        slot_id: Number(slotId), position: slots.length + 1, qtype, status: "not_exposed", ...(version ? { version } : {}),
        ...(questionId ? { question_id: Number(questionId) } : {}), ...(slotName(node) ? { name: slotName(node) } : {}), max_mark: maxMarkText || null, inspectable: !reason, ...(reason ? { reason } : {}), _questionId: questionId,
      });
    }
    return { slots, truncated: nodes.length > MAX_ITEMS };
  };
  const listQuizQuestions = async (context, inputValue, args) => {
    const bound = await quizBinding(context, args);
    if (!bound.ok) return bound;
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const page = await loadQuizDocument(rechecked, "/mod/quiz/edit.php", { cmid: args.module_id }, "moodle_quiz_questions_read_failed");
    if (!page.ok) return page;
    const parsed = parseQuizSlots(rechecked, page.document, args.module_id);
    if (!parsed) return { ...error("moodle_quiz_questions_target_invalid"), status: page.status };
    const questions = parsed.slots.map(({ _questionId, ...slot }) => slot);
    const data = sanitize({ course_id: Number(args.course_id), module_id: Number(args.module_id), questions, truncated: parsed.truncated });
    return { ok: true, sent: true, status: page.status, data, targets: quizTargets(rechecked, bound.course, bound.quiz), snapshot_digest: await digest(data), slots: parsed.slots };
  };
  const oneFormValue = (formData, name, maximum = MAX_BYTES) => {
    const values = formData.getAll(name);
    const value = values.length === 1 ? nativeText(values[0], maximum) : null;
    return value === null ? null : value;
  };
  const nativeBoolean = (form, formData, name) => {
    const controls = Array.from(form.querySelectorAll("[name]")).filter((control) => control.getAttribute("name") === name);
    const checkboxes = controls.filter((control) => String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    if (checkboxes.length === 1 && controls.every((control) => control === checkboxes[0] || String(control.getAttribute("type") || "").toLowerCase() === "hidden")) return Boolean(checkboxes[0].checked);
    if (checkboxes.length > 0) return null;
    const value = oneFormValue(formData, name, 1);
    return value === "0" ? false : value === "1" ? true : null;
  };
  const hasEmbeddedFile = (value) => /(?:draftfile\.php\/|@@PLUGINFILE@@|<\s*(?:img|audio|video|source|track|object|embed|iframe)\b|\b(?:src|poster)\s*=\s*["']?\s*(?:data:|blob:))/i.test(String(value));
  const richValue = (context, formData, name) => {
    const value = oneFormValue(formData, name);
    return value === null || hasEmbeddedFile(value) ? null : value;
  };
  const questionCommonData = (context, formData, qtype = "") => {
    const name = oneFormValue(formData, "name", 1333);
    const questionText = richValue(context, formData, "questiontext[text]");
    const questionTextFormat = oneFormValue(formData, "questiontext[format]", 32);
    const status = oneFormValue(formData, "status", 32);
    const defaultMark = qtype === "multianswer" ? null : oneFormValue(formData, "defaultmark", 64);
    const generalFeedback = richValue(context, formData, "generalfeedback[text]");
    const generalFeedbackFormat = oneFormValue(formData, "generalfeedback[format]", 32);
    const idNumber = oneFormValue(formData, "idnumber", 255);
    if ([name, questionText, questionTextFormat, generalFeedback, generalFeedbackFormat, idNumber].some((value) => value === null)
      || (qtype !== "multianswer" && defaultMark === null) || !["ready", "draft", "hidden"].includes(status || "")) return null;
    return { name, question_text: questionText, question_text_format: questionTextFormat, status, default_mark: defaultMark, general_feedback: generalFeedback, general_feedback_format: generalFeedbackFormat, id_number: idNumber };
  };
  const questionTagValues = (formData, name) => {
    const direct = formData.getAll(name);
    const selected = formData.getAll(`${name}[]`);
    if (!direct.length && !selected.length) return null;
    if (direct.length > 1 || direct.some((value) => value !== "_qf__force_multiselect_submission") || selected.length > MAX_ITEMS) return false;
    const values = selected.map((value) => nativeText(value, 255));
    if (values.some((value) => !value || value === "_qf__force_multiselect_submission") || new Set(values).size !== values.length) return false;
    return values.sort();
  };
  const questionTagDefaults = (formData) => {
    const tags = questionTagValues(formData, "tags");
    const courseTags = questionTagValues(formData, "coursetags");
    return tags === false || courseTags === false ? null : { tags, course_tags: courseTags };
  };
  const combinedFeedbackDefaults = (context, form, formData, hints) => {
    const combinedFeedback = {};
    for (const [field, name] of [["correctfeedback", "correct"], ["partiallycorrectfeedback", "partially_correct"], ["incorrectfeedback", "incorrect"]]) {
      const text = richValue(context, formData, `${field}[text]`);
      const format = oneFormValue(formData, `${field}[format]`, 32);
      if (text === null || !format) return null;
      combinedFeedback[name] = { text, format };
    }
    const penalty = oneFormValue(formData, "penalty", 64);
    const showNumCorrect = nativeBoolean(form, formData, "shownumcorrect");
    if (!penalty || !/^[0-9]+(?:[.,][0-9]+)?$/.test(penalty) || showNumCorrect === null || !hints) return null;
    return { combined_feedback: combinedFeedback, penalty, show_num_correct: showNumCorrect, hints };
  };
  const multipleChoiceDefaults = (context, form, formData) => combinedFeedbackDefaults(context, form, formData, questionHints(context, form, formData, true, true));
  const multipleChoiceData = (context, form, formData) => {
    const single = nativeBoolean(form, formData, "single");
    const shuffleAnswers = nativeBoolean(form, formData, "shuffleanswers");
    const answerNumbering = oneFormValue(formData, "answernumbering", 64);
    const showStandardInstruction = nativeBoolean(form, formData, "showstandardinstruction");
    const defaults = multipleChoiceDefaults(context, form, formData);
    if (single === null || shuffleAnswers === null || !answerNumbering || showStandardInstruction === null || !defaults) return null;
    const indexes = [...new Set(Array.from(formData.keys()).map((name) => name.match(/^answer\[([0-9]+)\]\[(?:text|format)\]$/)?.[1]).filter(Boolean))]
      .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
    if (!indexes.length) return null;
    const choices = [];
    for (const index of indexes) {
      const text = richValue(context, formData, `answer[${index}][text]`);
      const format = oneFormValue(formData, `answer[${index}][format]`, 32);
      const fraction = oneFormValue(formData, `fraction[${index}]`, 64);
      const feedback = richValue(context, formData, `feedback[${index}][text]`);
      const feedbackFormat = oneFormValue(formData, `feedback[${index}][format]`, 32);
      if ([text, format, fraction, feedback, feedbackFormat].some((value) => value === null)) return null;
      if (text === "" && feedback === "" && /^0(?:[.,]0+)?$/.test(fraction)) continue;
      choices.push({ text, format, fraction, feedback, feedback_format: feedbackFormat });
    }
    return { single, shuffle_answers: shuffleAnswers, answer_numbering: answerNumbering, show_standard_instruction: showStandardInstruction, ...defaults, choices: choices.slice(0, MAX_ITEMS), choices_truncated: choices.length > MAX_ITEMS };
  };
  const questionCategory = (form, formData, requireNativeName = false) => {
    const value = oneFormValue(formData, "category", 64);
    const match = value?.match(/^([1-9][0-9]*),([1-9][0-9]*)$/);
    if (!match || !match.slice(1).every((part) => Number.isSafeInteger(Number(part)))) return null;
    const controls = Array.from(form.querySelectorAll('[name="category"]'));
    if (controls.length !== 1) return null;
    const selected = Array.from(controls[0].querySelectorAll("option")).filter((entry) => entry.selected);
    const nativeName = selected.length === 1 ? nativeText(selected[0].textContent || "", 500)?.replace(/\s+/g, " ").trim() : "";
    if (requireNativeName && !nativeName) return null;
    const name = nativeName || `Question bank category ${match[1]}`;
    return { category_id: Number(match[1]), context_id: Number(match[2]), name };
  };
  const savedQuestionCategory = async (context, inputValue, args, questionId, qtype) => {
    const current = currentContext();
    if (!sameContext(context, current) || validateBinding(current, inputValue.binding)) return null;
    const path = "/question/bank/editquestion/question.php";
    const params = { id: questionId, cmid: args.module_id, makecopy: "1" };
    const page = await loadQuizDocument(current, path, params, "moodle_question_category_read_failed");
    if (!page.ok) return null;
    const endpoint = urlFor(current, path, params);
    const forms = Array.from(page.document.querySelectorAll("form")).filter((form) => {
      if (String(form.getAttribute("method") || "get").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || endpoint, endpoint);
        const data = new FormData(form);
        return action.origin === current.profile.origin && action.pathname === new URL(endpoint).pathname
          && oneFormValue(data, "id", 32) === questionId && oneFormValue(data, "cmid", 32) === args.module_id
          && oneFormValue(data, "courseid", 32) === args.course_id && oneFormValue(data, "qtype", 64) === qtype
          && oneFormValue(data, "makecopy", 2) === "1" && Boolean(nativeFormSesskey(current, data));
      } catch { return false; }
    });
    if (forms.length !== 1) return null;
    const selectors = Array.from(forms[0].querySelectorAll('[name="categorymoveto"]'));
    const currentControls = Array.from(forms[0].querySelectorAll('[name="usecurrentcat"]'));
    if (selectors.length !== 1 || selectors[0].tagName !== "SELECT" || currentControls.length !== 1
      || currentControls[0].tagName !== "INPUT" || currentControls[0].type !== "checkbox" || !currentControls[0].checked
      || currentControls[0].value !== "1") return null;
    // Moodle freezes the saved category. Its unsent copy form selects the original category, even when disabled.
    const selected = Array.from(selectors[0].options).filter((option) => option.selected);
    if (selected.length !== 1 || selected[0].disabled) return null;
    const match = selected[0].value.match(/^([1-9][0-9]*),([1-9][0-9]*)$/);
    const name = nativeText(selected[0].textContent || "", 500)?.replace(/\s+/g, " ").trim();
    if (!match || !name || !match.slice(1).every((part) => Number.isSafeInteger(Number(part)))) return null;
    return { category_id: Number(match[1]), context_id: Number(match[2]), name };
  };
  const questionAnswerControls = (form, formData) => {
    const indexes = [...new Set(Array.from(formData.keys()).map((name) => name.match(/^answer\[([0-9]+)\]\[text\]$/)?.[1]).filter(Boolean))]
      .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
    if (indexes.length < 2 || indexes.some((entry, index) => entry !== index)) return null;
    const controls = [];
    for (const index of indexes) {
      const format = oneFormValue(formData, `answer[${index}][format]`, 32);
      const feedbackFormat = oneFormValue(formData, `feedback[${index}][format]`, 32);
      const fractionControls = Array.from(form.querySelectorAll("[name]")).filter((control) => control.getAttribute("name") === `fraction[${index}]`);
      const fraction = fractionControls[0];
      if (!format || !feedbackFormat || fractionControls.length !== 1 || fraction?.tagName !== "SELECT" || fraction.disabled
        || ["1.0", "0.0"].some((value) => Array.from(fraction.options).filter((option) => !option.disabled && option.value === value).length !== 1)) return null;
      controls.push({ format, feedback_format: feedbackFormat });
    }
    return controls;
  };
  const questionAnswerControlsFor = (form, formData, numerical = false) => {
    const indexes = [...new Set(Array.from(formData.keys()).map((name) => name.match(/^answer\[([0-9]+)\]\[text\]$/)?.[1]).filter(Boolean))]
      .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
    if (!indexes.length || indexes.length > MAX_ITEMS || indexes.some((entry, index) => entry !== index)) return null;
    const controls = [];
    for (const index of indexes) {
      const format = oneFormValue(formData, `answer[${index}][format]`, 32);
      const feedbackFormat = oneFormValue(formData, `feedback[${index}][format]`, 32);
      const fractionControls = Array.from(form.querySelectorAll("[name]")).filter((control) => control.getAttribute("name") === `fraction[${index}]`);
      const fraction = fractionControls[0];
      const textControls = Array.from(form.querySelectorAll("[name]")).filter((control) => control.getAttribute("name") === `answer[${index}][text]`);
      const feedbackControls = Array.from(form.querySelectorAll("[name]")).filter((control) => control.getAttribute("name") === `feedback[${index}][text]`);
      const options = fraction?.tagName === "SELECT" && !fraction.disabled ? Array.from(fraction.options).filter((option) => !option.disabled).map((option) => String(option.value || "")).filter(Boolean) : [];
      if (!format || !feedbackFormat || fractionControls.length !== 1 || textControls.length !== 1 || feedbackControls.length !== 1 || textControls[0].disabled || feedbackControls[0].disabled
        || !options.length || options.length > MAX_ITEMS || new Set(options).size !== options.length) return null;
      if (numerical) {
        const toleranceControls = Array.from(form.querySelectorAll("[name]")).filter((control) => control.getAttribute("name") === `tolerance[${index}]`);
        if (toleranceControls.length !== 1 || toleranceControls[0].disabled) return null;
      }
      controls.push({ format, feedback_format: feedbackFormat, fraction_options: options, ...(numerical ? { tolerance: true } : {}) });
    }
    return controls;
  };
  const matchingControls = (form, formData) => {
    const indexes = [...new Set(Array.from(formData.keys()).map((name) => name.match(/^subquestions\[([0-9]+)\]\[text\]$/)?.[1]).filter(Boolean))]
      .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
    if (indexes.length < 3 || indexes.length > MAX_ITEMS || indexes.some((entry, index) => entry !== index)) return null;
    const rows = [];
    for (const index of indexes) {
      const format = oneFormValue(formData, `subquestions[${index}][format]`, 32);
      const questionControls = Array.from(form.querySelectorAll("[name]")).filter((control) => control.getAttribute("name") === `subquestions[${index}][text]`);
      const answerControls = Array.from(form.querySelectorAll("[name]")).filter((control) => control.getAttribute("name") === `subanswers[${index}]`);
      if (!format || questionControls.length !== 1 || answerControls.length !== 1 || questionControls[0].disabled || answerControls[0].disabled) return null;
      rows.push({ question_text_format: format });
    }
    return rows;
  };
  const questionCreationDetails = (qtype, context, form, formData) => {
    if (qtype === "match") {
      const shuffleAnswers = nativeBoolean(form, formData, "shuffleanswers");
      const defaults = multipleChoiceDefaults(context, form, formData);
      return shuffleAnswers === null || !defaults ? null : { shuffle_answers: shuffleAnswers, ...defaults };
    }
    if (["gapselect", "ddwtos"].includes(qtype)) return gapselectData(qtype, context, form, formData, false);
    if (qtype === "multianswer") return multianswerData(context, form, formData, false);
    return questionDetails(qtype, context, form, formData);
  };
  const questionCreationControls = (qtype, form, formData) => {
    if (qtype === "multichoice") return questionAnswerControls(form, formData);
    if (qtype === "shortanswer") return questionAnswerControlsFor(form, formData);
    if (qtype === "numerical") return questionAnswerControlsFor(form, formData, true);
    if (qtype === "match") return matchingControls(form, formData);
    if (["gapselect", "ddwtos"].includes(qtype)) return gapselectChoiceControls(qtype, form, formData);
    if (qtype === "truefalse") {
      const select = Array.from(form.querySelectorAll('[name="correctanswer"]')).filter((control) => control.tagName === "SELECT" && !control.disabled);
      const trueFeedback = oneFormValue(formData, "feedbacktrue[format]", 32);
      const falseFeedback = oneFormValue(formData, "feedbackfalse[format]", 32);
      const options = select.length === 1 ? Array.from(select[0].options).filter((option) => !option.disabled).map((option) => String(option.value || "")) : [];
      return options.length === 2 && new Set(options).size === 2 && options.includes("0") && options.includes("1") && trueFeedback && falseFeedback
        ? { correct_answer_options: options, true_feedback_format: trueFeedback, false_feedback_format: falseFeedback } : null;
    }
    return ["essay", "description", "multianswer"].includes(qtype) ? {} : null;
  };
  const questionHasCustomFields = (form) => Array.from(form.querySelectorAll("[name]")).some((control) => /^customfield(?:_|\[)/i.test(String(control.getAttribute("name") || "")));
  const uniqueQuery = (url) => {
    const params = {};
    for (const [name, value] of url.searchParams.entries()) {
      if (Object.hasOwn(params, name)) return null;
      params[name] = value;
    }
    return params;
  };
  const localQuizReturnUrl = (context, value, moduleId) => {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
    let parsed;
    try { parsed = new URL(value, context.profile.origin); } catch { return null; }
    if (parsed.origin !== context.profile.origin || parsed.username || parsed.password || parsed.hash) return null;
    const relativePath = context.basePath && parsed.pathname.startsWith(`${context.basePath}/`)
      ? parsed.pathname.slice(context.basePath.length) : parsed.pathname;
    if (relativePath !== "/mod/quiz/edit.php") return null;
    const params = uniqueQuery(parsed);
    return params && params.cmid === moduleId && !Object.values(params).some((entry) => typeof entry !== "string") ? { value, params } : null;
  };
  const relativeMoodlePath = (context, url) => {
    if (url.origin !== context.profile.origin) return "";
    if (!context.basePath) return url.pathname;
    return url.pathname.startsWith(`${context.basePath}/`) ? url.pathname.slice(context.basePath.length) : "";
  };
  const nativeAddQuestionRoute = (context, documentValue, moduleId) => {
    const endpoint = new URL(urlFor(context, "/question/bank/editquestion/addquestion.php"));
    const matches = [];
    for (const anchor of documentValue.querySelectorAll("a[href]")) {
      let url;
      try { url = new URL(anchor.getAttribute("href"), endpoint); } catch { continue; }
      if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname) continue;
      const params = uniqueQuery(url);
      if (!params || params.cmid !== moduleId || !id(params.category) || params.appendqnumstring !== "addquestion") continue;
      const returnurl = localQuizReturnUrl(context, params.returnurl, moduleId);
      if (!returnurl) continue;
      matches.push({ params, categoryId: params.category, returnurl });
    }
    return matches.length === 1 ? matches[0] : null;
  };
  const nativeQuestionChooserRoute = (context, documentValue, nativeRoute, moduleId, qtype) => {
    const endpoint = new URL(urlFor(context, "/question/bank/editquestion/question.php"));
    const matches = [];
    for (const form of documentValue.querySelectorAll("form")) {
      if (String(form.getAttribute("method") || "get").toLowerCase() !== "get") continue;
      let action;
      let formData;
      try { action = new URL(form.getAttribute("action") || endpoint, endpoint); formData = new FormData(form); } catch { continue; }
      if (action.origin !== endpoint.origin || action.pathname !== endpoint.pathname
        || oneFormValue(formData, "category", 32) !== nativeRoute.categoryId
        || oneFormValue(formData, "cmid", 32) !== moduleId
        || oneFormValue(formData, "returnurl", MAX_BYTES) !== nativeRoute.returnurl.value
        || oneFormValue(formData, "appendqnumstring", 32) !== "addquestion") continue;
      const qtypes = Array.from(form.querySelectorAll('[name="qtype"]')).filter((control) => control.getAttribute("value") === qtype);
      if (qtypes.length !== 1) continue;
      formData.set("qtype", qtype);
      const params = new URLSearchParams();
      let valid = true;
      for (const [name, value] of formData.entries()) {
        if (typeof value !== "string" || params.has(name)) { valid = false; break; }
        params.set(name, value);
      }
      if (!valid) continue;
      action.search = params.toString();
      const routeParams = uniqueQuery(action);
      if (!routeParams || routeParams.qtype !== qtype || routeParams.category !== nativeRoute.categoryId
        || routeParams.cmid !== moduleId || routeParams.returnurl !== nativeRoute.returnurl.value || routeParams.appendqnumstring !== "addquestion") continue;
      matches.push({ path: relativeMoodlePath(context, action), params: routeParams });
    }
    return matches.length === 1 && matches[0].path === "/question/bank/editquestion/question.php" ? matches[0] : null;
  };
  const questionFileAreas = (fileManagers) => fileManagers.filter(({ state }) => state !== "empty").map(({ name, state }) => ({ name, state }));
  const questionAnswerRows = (context, formData, numerical = false) => {
    const indexes = [...new Set(Array.from(formData.keys()).map((name) => name.match(/^answer\[([0-9]+)\]\[text\]$/)?.[1]).filter(Boolean))]
      .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
    if (!indexes.length || indexes.length > MAX_ITEMS || indexes.some((entry, index) => entry !== index)) return null;
    const answers = [];
    for (const index of indexes) {
      const answerText = richValue(context, formData, `answer[${index}][text]`);
      const format = oneFormValue(formData, `answer[${index}][format]`, 32);
      const fraction = oneFormValue(formData, `fraction[${index}]`, 64);
      const feedback = richValue(context, formData, `feedback[${index}][text]`);
      const feedbackFormat = oneFormValue(formData, `feedback[${index}][format]`, 32);
      const tolerance = numerical ? oneFormValue(formData, `tolerance[${index}]`, 64) : "";
      if ([answerText, format, fraction, feedback, feedbackFormat].some((value) => value === null) || (numerical && tolerance === null)) return null;
      if (answerText === "" && feedback === "" && /^0(?:[.,]0+)?$/.test(fraction) && (!numerical || !tolerance || /^0(?:[.,]0+)?$/.test(tolerance))) continue;
      answers.push({ text: answerText, format, fraction, feedback, feedback_format: feedbackFormat, ...(numerical ? { tolerance } : {}) });
    }
    return answers;
  };
  const questionHints = (context, form, formData, withClearWrong = false, withShowNumCorrect = false) => {
    const indexes = [...new Set(Array.from(formData.keys()).map((name) => name.match(/^hint\[([0-9]+)\]\[text\]$/)?.[1]).filter(Boolean))]
      .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
    if (indexes.length > MAX_ITEMS || indexes.some((entry, index) => entry !== index)) return null;
    const hints = [];
    for (const index of indexes) {
      const text = richValue(context, formData, `hint[${index}][text]`);
      const format = oneFormValue(formData, `hint[${index}][format]`, 32);
      const clearWrong = withClearWrong ? nativeBoolean(form, formData, `hintclearwrong[${index}]`) : false;
      const showNumCorrect = withShowNumCorrect ? nativeBoolean(form, formData, `hintshownumcorrect[${index}]`) : false;
      if (text === null || !format || clearWrong === null || showNumCorrect === null) return null;
      if (text !== "" || clearWrong || showNumCorrect) hints.push({ text, format, ...(withClearWrong ? { clear_wrong: clearWrong } : {}), ...(withShowNumCorrect ? { show_num_correct: showNumCorrect } : {}) });
    }
    return hints;
  };
  const nativeHintBoolean = (form, formData, index, field) => {
    const direct = `${field}[${index}]`;
    const nested = `hintoptions[${index}][${field}]`;
    if (namedControls(form, direct).length) return nativeBoolean(form, formData, direct);
    return namedControls(form, nested).length ? nativeBoolean(form, formData, nested) : null;
  };
  const orderingHints = (context, form, formData) => {
    const indexes = [...new Set(Array.from(formData.keys()).map((name) => name.match(/^hint\[([0-9]+)\]\[text\]$/)?.[1]).filter(Boolean))]
      .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
    if (indexes.length > MAX_ITEMS || indexes.some((entry, index) => entry !== index)) return null;
    const hints = [];
    for (const index of indexes) {
      const text = richValue(context, formData, `hint[${index}][text]`);
      const format = oneFormValue(formData, `hint[${index}][format]`, 32);
      const showNumCorrect = nativeHintBoolean(form, formData, index, "hintshownumcorrect");
      const highlightResponse = nativeHintBoolean(form, formData, index, "hintoptions");
      if (text === null || !format || showNumCorrect === null || highlightResponse === null) return null;
      if (text !== "" || showNumCorrect || highlightResponse) hints.push({ text, format, show_num_correct: showNumCorrect, highlight_response: highlightResponse });
    }
    return hints;
  };
  const orderingDefaults = (context, form, formData) => combinedFeedbackDefaults(context, form, formData, orderingHints(context, form, formData));
  const interactiveQuestionData = (context, form, formData, withClearWrong = false, withShowNumCorrect = false) => {
    const penalty = oneFormValue(formData, "penalty", 64);
    const hints = questionHints(context, form, formData, withClearWrong, withShowNumCorrect);
    if (!penalty || !/^[0-9]+(?:[.,][0-9]+)?$/.test(penalty) || !hints) return null;
    return { penalty, hints };
  };
  const trueFalseData = (context, form, formData) => {
    const correctAnswer = oneFormValue(formData, "correctanswer", 1);
    const showStandardInstruction = nativeBoolean(form, formData, "showstandardinstruction");
    const trueFeedback = richValue(context, formData, "feedbacktrue[text]");
    const trueFeedbackFormat = oneFormValue(formData, "feedbacktrue[format]", 32);
    const falseFeedback = richValue(context, formData, "feedbackfalse[text]");
    const falseFeedbackFormat = oneFormValue(formData, "feedbackfalse[format]", 32);
    const penalty = oneFormValue(formData, "penalty", 64);
    if (!["0", "1"].includes(correctAnswer || "") || showStandardInstruction === null || trueFeedback === null || !trueFeedbackFormat
      || falseFeedback === null || !falseFeedbackFormat || !penalty || !/^[0-9]+(?:[.,][0-9]+)?$/.test(penalty)) return null;
    return { correct_answer: correctAnswer === "1", show_standard_instruction: showStandardInstruction, true_feedback: trueFeedback, true_feedback_format: trueFeedbackFormat, false_feedback: falseFeedback, false_feedback_format: falseFeedbackFormat, penalty };
  };
  const shortAnswerData = (context, form, formData) => {
    const useCase = oneFormValue(formData, "usecase", 1);
    const answers = questionAnswerRows(context, formData);
    const interactive = interactiveQuestionData(context, form, formData);
    if (!["0", "1"].includes(useCase || "") || !answers || !interactive) return null;
    return { case_sensitive: useCase === "1", answers, ...interactive };
  };
  const numericalUnitData = (formData) => {
    const unitRole = oneFormValue(formData, "unitrole", 32);
    const unitPenalty = oneFormValue(formData, "unitpenalty", 64);
    const unitGradingType = oneFormValue(formData, "unitgradingtypes", 32);
    const multipleChoiceDisplay = oneFormValue(formData, "multichoicedisplay", 32);
    const unitsLeft = oneFormValue(formData, "unitsleft", 1);
    if (!unitRole || !unitPenalty || !unitGradingType || !multipleChoiceDisplay || !["0", "1"].includes(unitsLeft || "")) return null;
    const indexes = [...new Set(Array.from(formData.keys()).map((name) => name.match(/^unit\[([0-9]+)\]$/)?.[1]).filter(Boolean))]
      .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
    if (indexes.length > MAX_ITEMS || indexes.some((entry, index) => entry !== index)) return null;
    const units = [];
    for (const index of indexes) {
      const unit = oneFormValue(formData, `unit[${index}]`, 255);
      const multiplier = oneFormValue(formData, `multiplier[${index}]`, 64);
      if (unit === null || multiplier === null) return null;
      if (unit) units.push({ unit, multiplier });
    }
    return { unit_role: unitRole, unit_penalty: unitPenalty, unit_grading_type: unitGradingType, multiple_choice_display: multipleChoiceDisplay, units_left: unitsLeft === "1", units };
  };
  const numericalData = (context, form, formData) => {
    const answers = questionAnswerRows(context, formData, true);
    const interactive = interactiveQuestionData(context, form, formData);
    const units = numericalUnitData(formData);
    if (!answers || !interactive || !units) return null;
    return { answers, ...interactive, ...units };
  };
  const matchData = (context, form, formData) => {
    const shuffleAnswers = nativeBoolean(form, formData, "shuffleanswers");
    const defaults = multipleChoiceDefaults(context, form, formData);
    const indexes = [...new Set(Array.from(formData.keys()).map((name) => name.match(/^subquestions\[([0-9]+)\]\[text\]$/)?.[1]).filter(Boolean))]
      .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
    if (shuffleAnswers === null || !defaults || indexes.length < 3 || indexes.length > MAX_ITEMS || indexes.some((entry, index) => entry !== index)) return null;
    const pairs = [];
    const distractors = [];
    for (const index of indexes) {
      const questionText = richValue(context, formData, `subquestions[${index}][text]`);
      const questionTextFormat = oneFormValue(formData, `subquestions[${index}][format]`, 32);
      const answerText = oneFormValue(formData, `subanswers[${index}]`, 255);
      if (questionText === null || !questionTextFormat || answerText === null) return null;
      if (!questionText && !answerText) continue;
      if (questionText && answerText) pairs.push({ question_text: questionText, question_text_format: questionTextFormat, answer_text: answerText });
      else if (!questionText && answerText) distractors.push(answerText);
      else return null;
    }
    if (pairs.length < 2 || distractors.length < 1) return null;
    return { shuffle_answers: shuffleAnswers, pairs, distractors, ...defaults };
  };
  const orderingData = (context, form, formData) => {
    const values = {};
    for (const field of ["layouttype", "selecttype", "gradingtype", "showgrading", "numberingstyle"]) {
      const value = oneFormValue(formData, field, 64);
      const options = availableSelectValues(form, field);
      if (!value || !options.includes(value)) return null;
      values[field] = value;
    }
    const selectCount = oneFormValue(formData, "selectcount", 32);
    const defaults = orderingDefaults(context, form, formData);
    const indexes = [...new Set(Array.from(formData.keys()).map((name) => name.match(/^answer\[([0-9]+)\]\[text\]$/)?.[1]).filter(Boolean))]
      .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
    if (!selectCount || !/^[0-9]+$/.test(selectCount) || !defaults || !indexes.length || indexes.length > MAX_ITEMS || indexes.some((entry, index) => entry !== index)) return null;
    const items = [];
    for (const index of indexes) {
      const text = richValue(context, formData, `answer[${index}][text]`);
      const format = oneFormValue(formData, `answer[${index}][format]`, 32);
      if (text === null || !format) return null;
      if (text.trim()) items.push({ text, format });
    }
    if (items.length < 2) return null;
    return { layout_type: values.layouttype, select_type: values.selecttype, select_count: Number(selectCount), grading_type: values.gradingtype,
      show_grading: values.showgrading === "1", numbering_style: values.numberingstyle, items, ...defaults };
  };
  const randomSamatchData = (context, form, formData) => {
    const choose = oneFormValue(formData, "choose", 32);
    const chooseOptions = availableSelectValues(form, "choose");
    const includeSubcategories = nativeBoolean(form, formData, "subcats");
    const fraction = oneFormValue(formData, "fraction", 8);
    const defaults = multipleChoiceDefaults(context, form, formData);
    if (!choose || !chooseOptions.includes(choose) || !/^[1-9][0-9]*$/.test(choose) || Number(choose) < 2 || Number(choose) > 10
      || includeSubcategories === null || fraction !== "0" || !defaults) return null;
    return { choose: Number(choose), include_subcategories: includeSubcategories, fraction, ...defaults };
  };
  const essayData = (context, form, formData) => {
    const responseFormat = oneFormValue(formData, "responseformat", 64);
    const responseRequired = nativeBoolean(form, formData, "responserequired");
    const responseFieldLines = oneFormValue(formData, "responsefieldlines", 32);
    const wordLimit = (prefix) => {
      const enabled = formData.getAll(`${prefix}enabled`);
      if (enabled.length === 0) return "";
      return enabled.length === 1 && enabled[0] === "1" ? oneFormValue(formData, `${prefix}limit`, 32) : null;
    };
    const minWordLimit = wordLimit("minword");
    const maxWordLimit = wordLimit("maxword");
    const responseTemplate = richValue(context, formData, "responsetemplate[text]");
    const responseTemplateFormat = oneFormValue(formData, "responsetemplate[format]", 32);
    const graderInfo = richValue(context, formData, "graderinfo[text]");
    const graderInfoFormat = oneFormValue(formData, "graderinfo[format]", 32);
    const attachments = oneFormValue(formData, "attachments", 32);
    const attachmentsRequired = oneFormValue(formData, "attachmentsrequired", 32);
    const filetypes = oneFormValue(formData, "filetypeslist", 40000);
    const maxBytes = oneFormValue(formData, "maxbytes", 32);
    if (!responseFormat || responseRequired === null || !responseFieldLines || minWordLimit === null || maxWordLimit === null
      || responseTemplate === null || !responseTemplateFormat || graderInfo === null || !graderInfoFormat || attachments === null
      || attachmentsRequired === null || filetypes === null || maxBytes === null) return null;
    return { response_format: responseFormat, response_required: responseRequired, response_field_lines: responseFieldLines, min_word_limit: minWordLimit || null, max_word_limit: maxWordLimit || null, attachments, attachments_required: attachmentsRequired, accepted_file_types: filetypes, max_bytes: maxBytes, response_template: responseTemplate, response_template_format: responseTemplateFormat, grader_info: graderInfo, grader_info_format: graderInfoFormat };
  };
  const gapselectChoiceIndexes = (formData) => [...new Set(Array.from(formData.keys()).map((name) => name.match(/^choices\[([0-9]+)\]\[answer\]$/)?.[1]).filter(Boolean))]
    .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
  const gapselectChoiceControls = (qtype, form, formData) => {
    const indexes = gapselectChoiceIndexes(formData);
    if (!indexes.length || indexes.length > MAX_ITEMS || indexes.some((entry, index) => entry !== index)) return null;
    const controls = [];
    for (const index of indexes) {
      const answerName = `choices[${index}][answer]`;
      const groupName = `choices[${index}][choicegroup]`;
      const answers = namedControls(form, answerName).filter((control) => ["INPUT", "TEXTAREA"].includes(control.tagName));
      const groups = namedControls(form, groupName).filter((control) => control.tagName === "SELECT");
      const groupOptions = groups.length === 1 && !groups[0].disabled
        ? Array.from(groups[0].options).filter((option) => !option.disabled).map((option) => String(option.value || "")).filter(Boolean) : [];
      if (answers.length !== 1 || answers[0].disabled || !groupOptions.length || groupOptions.length > MAX_ITEMS || new Set(groupOptions).size !== groupOptions.length) return null;
      if (qtype === "ddwtos" && nativeBoolean(form, formData, `choices[${index}][infinite]`) === null) return null;
      controls.push({ group_options: groupOptions });
    }
    return controls;
  };
  const gapselectChoiceData = (qtype, form, formData) => {
    const indexes = gapselectChoiceIndexes(formData);
    if (!indexes.length || indexes.length > MAX_ITEMS || indexes.some((entry, index) => entry !== index)) return null;
    const choices = [];
    for (const index of indexes) {
      const text = oneFormValue(formData, `choices[${index}][answer]`, 255);
      const groupValue = oneFormValue(formData, `choices[${index}][choicegroup]`, 32);
      const unlimited = qtype === "ddwtos" ? nativeBoolean(form, formData, `choices[${index}][infinite]`) : false;
      if (text === null || groupValue === null || unlimited === null || !/^[1-9][0-9]*$/.test(groupValue)) return null;
      if (!text.trim()) continue;
      choices.push({ text, group: Number(groupValue), ...(qtype === "ddwtos" ? { unlimited } : {}) });
    }
    return choices;
  };
  const gapselectData = (qtype, context, form, formData, requireSlots = true) => {
    const shuffleAnswers = nativeBoolean(form, formData, "shuffleanswers");
    const defaults = multipleChoiceDefaults(context, form, formData);
    const choices = gapselectChoiceData(qtype, form, formData);
    const questionText = richValue(context, formData, "questiontext[text]");
    if (shuffleAnswers === null || !defaults || !choices || questionText === null || (requireSlots && (!validGapselectChoices(qtype, choices) || !validGapselectSlots(qtype, questionText, choices)))) return null;
    return { shuffle_answers: shuffleAnswers, choices, ...defaults };
  };
  const multianswerData = (context, form, formData, requireSource = true) => {
    const source = richValue(context, formData, "questiontext[text]");
    const parsed = source === null ? null : multianswerSource(source);
    const interactive = interactiveQuestionData(context, form, formData, true, true);
    return interactive && (!requireSource || parsed) ? { source_syntax: "shortanswer_exact", ...(parsed || {}), ...interactive } : null;
  };
  const repeatedIndexes = (formData, pattern) => [...new Set(Array.from(formData.keys()).map((name) => name.match(pattern)?.[1]).filter(Boolean))]
    .map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right);
  const dragToImageRows = (formData, countName, pattern) => {
    const count = oneFormValue(formData, countName, 32);
    const indexes = repeatedIndexes(formData, pattern);
    return count === null || !/^(?:0|[1-9][0-9]*)$/.test(count) || Number(count) > MAX_ITEMS
      || indexes.length !== Number(count) || indexes.some((entry, index) => entry !== index) ? null : indexes;
  };
  const dragMarkerHints = (context, form, formData) => {
    const indexes = repeatedIndexes(formData, /^hint\[([0-9]+)\]\[text\]$/);
    if (indexes.length > MAX_ITEMS || indexes.some((entry, index) => entry !== index)) return null;
    const hints = [];
    for (const index of indexes) {
      const text = richValue(context, formData, `hint[${index}][text]`);
      const format = oneFormValue(formData, `hint[${index}][format]`, 32);
      const clearWrong = nativeHintBoolean(form, formData, index, "hintclearwrong");
      const showNumCorrect = nativeHintBoolean(form, formData, index, "hintshownumcorrect");
      const stateIncorrectlyPlaced = nativeHintBoolean(form, formData, index, "hintoptions");
      if (text === null || !format || clearWrong === null || showNumCorrect === null || stateIncorrectlyPlaced === null) return null;
      if (text !== "" || clearWrong || showNumCorrect || stateIncorrectlyPlaced) hints.push({ text, format, clear_wrong: clearWrong, show_num_correct: showNumCorrect, state_incorrectly_placed: stateIncorrectlyPlaced });
    }
    return hints;
  };
  const dragImageData = (context, form, formData) => {
    const shuffleAnswers = nativeBoolean(form, formData, "shuffleanswers");
    const visibility = oneFormValue(formData, "dropzonevisibility", 32);
    const defaults = combinedFeedbackDefaults(context, form, formData, questionHints(context, form, formData, true, true));
    const itemIndexes = dragToImageRows(formData, "noitems", /^drags\[([0-9]+)\]\[draggroup\]$/);
    const zoneIndexes = dragToImageRows(formData, "nodropzone", /^drops\[([0-9]+)\]\[choice\]$/);
    if (shuffleAnswers === null || !visibility || !availableSelectValues(form, "dropzonevisibility").includes(visibility)
      || !defaults || !itemIndexes || !zoneIndexes) return null;
    const dragItems = [];
    for (const index of itemIndexes) {
      const type = oneFormValue(formData, `drags[${index}][dragitemtype]`, 32);
      const group = oneFormValue(formData, `drags[${index}][draggroup]`, 32);
      const unlimited = nativeBoolean(form, formData, `drags[${index}][infinite]`);
      const label = oneFormValue(formData, `draglabel[${index}]`, 255);
      if (!type || !availableSelectValues(form, `drags[${index}][dragitemtype]`).includes(type) || !group
        || !availableSelectValues(form, `drags[${index}][draggroup]`).includes(group) || !/^[1-9][0-9]*$/.test(group)
        || unlimited === null || label === null) return null;
      dragItems.push({ number: index + 1, content_type: type, label, group: Number(group), unlimited });
    }
    const dropZones = [];
    for (const index of zoneIndexes) {
      const left = oneFormValue(formData, `drops[${index}][xleft]`, 32);
      const top = oneFormValue(formData, `drops[${index}][ytop]`, 32);
      const choice = oneFormValue(formData, `drops[${index}][choice]`, 32);
      const label = oneFormValue(formData, `drops[${index}][droplabel]`, 255);
      if (left === null || top === null || label === null || !choice
        || !availableSelectValues(form, `drops[${index}][choice]`).includes(choice) || !/^(?:0|[1-9][0-9]*)$/.test(choice)) return null;
      if (choice === "0" && !left && !top && !label) continue;
      dropZones.push({ number: index + 1, x_left: left, y_top: top, drag_item: choice === "0" ? null : Number(choice), label });
    }
    return { shuffle_answers: shuffleAnswers, drop_zone_visibility: visibility, drag_items: dragItems, drop_zones: dropZones, ...defaults };
  };
  const dragMarkerData = (context, form, formData) => {
    const shuffleAnswers = nativeBoolean(form, formData, "shuffleanswers");
    const showMisplaced = nativeBoolean(form, formData, "showmisplaced");
    const defaults = combinedFeedbackDefaults(context, form, formData, dragMarkerHints(context, form, formData));
    const markerIndexes = dragToImageRows(formData, "noitems", /^drags\[([0-9]+)\]\[label\]$/);
    const zoneIndexes = dragToImageRows(formData, "nodropzone", /^drops\[([0-9]+)\]\[choice\]$/);
    if (shuffleAnswers === null || showMisplaced === null || !defaults || !markerIndexes || !zoneIndexes) return null;
    const markers = [];
    for (const index of markerIndexes) {
      const label = oneFormValue(formData, `drags[${index}][label]`, 255);
      const drags = oneFormValue(formData, `drags[${index}][noofdrags]`, 32);
      if (label === null || !drags || !availableSelectValues(form, `drags[${index}][noofdrags]`).includes(drags)
        || !/^(?:0|[1-9][0-9]*)$/.test(drags)) return null;
      markers.push({ number: index + 1, label, unlimited: drags === "0", max_drags: drags === "0" ? null : Number(drags) });
    }
    const dropZones = [];
    for (const index of zoneIndexes) {
      const shape = oneFormValue(formData, `drops[${index}][shape]`, 32);
      const choice = oneFormValue(formData, `drops[${index}][choice]`, 32);
      const coordinates = oneFormValue(formData, `drops[${index}][coords]`, 1333);
      if (coordinates === null || !shape || !availableSelectValues(form, `drops[${index}][shape]`).includes(shape) || !choice
        || !availableSelectValues(form, `drops[${index}][choice]`).includes(choice) || !/^(?:0|[1-9][0-9]*)$/.test(choice)) return null;
      if (choice === "0" && !coordinates.trim()) continue;
      dropZones.push({ number: index + 1, shape, marker: choice === "0" ? null : Number(choice), coordinates });
    }
    return { shuffle_answers: shuffleAnswers, show_misplaced: showMisplaced, markers, drop_zones: dropZones, ...defaults };
  };
  const dragToImageTypes = new Set(["ddimageortext", "ddmarker"]);
  const dragToImageBackground = async (context, formData) => {
    const values = formData.getAll("bgimage");
    const itemId = values.length === 1 ? draftItemId(nativeText(values[0], 32) || "") : "";
    if (!itemId) return null;
    const listing = await readDraftListing(context, itemId);
    if (!isObject(listing) || !Number.isSafeInteger(listing.filecount) || listing.filecount < 0 || listing.filecount > 1
      || !Array.isArray(listing.list) || listing.list.length !== listing.filecount) return null;
    if (listing.filecount === 0) return { file: null };
    const entry = listing.list[0];
    if (!isObject(entry) || entry.filepath !== "/" || entry.type !== "file" || !validResourceFilename(entry.filename)) return null;
    const label = nativeText(entry.mimetype, 1333);
    const size = entry.size === null ? 0 : entry.size;
    if (!label || !label.trim() || !Number.isSafeInteger(size) || size < 0) return null;
    return { file: { filename: entry.filename, size_bytes: size, media_type_label: label } };
  };
  const calculatedQuestionTypes = new Set(["calculated", "calculatedmulti", "calculatedsimple"]);
  // The wildcard pattern Moodle itself uses: question/type/calculated/questiontype.php PLACEHODLER_REGEX.
  const calculatedWildcardNames = (values) => {
    const names = new Set();
    for (const value of values) {
      for (const match of String(value).matchAll(/\{([A-Za-z][A-Za-z0-9\-_\s]*)\}/g)) names.add(match[1]);
    }
    return [...names].sort();
  };
  const calculatedAnswerRows = (context, formData, qtype) => {
    const editorAnswers = qtype === "calculatedmulti";
    const indexes = repeatedIndexes(formData, editorAnswers ? /^answer\[([0-9]+)\]\[text\]$/ : /^answer\[([0-9]+)\]$/);
    if (!indexes.length || indexes.length > MAX_ITEMS || indexes.some((entry, index) => entry !== index)) return null;
    const answers = [];
    for (const index of indexes) {
      const formula = editorAnswers ? richValue(context, formData, `answer[${index}][text]`) : oneFormValue(formData, `answer[${index}]`, 1333);
      const formulaFormat = editorAnswers ? oneFormValue(formData, `answer[${index}][format]`, 32) : "";
      const fraction = oneFormValue(formData, `fraction[${index}]`, 64);
      const tolerance = oneFormValue(formData, `tolerance[${index}]`, 64);
      const toleranceType = oneFormValue(formData, `tolerancetype[${index}]`, 32);
      const answerLength = oneFormValue(formData, `correctanswerlength[${index}]`, 32);
      const answerFormat = oneFormValue(formData, `correctanswerformat[${index}]`, 32);
      const feedback = richValue(context, formData, `feedback[${index}][text]`);
      const feedbackFormat = oneFormValue(formData, `feedback[${index}][format]`, 32);
      if ([formula, fraction, tolerance, feedback].some((value) => value === null) || !feedbackFormat || (editorAnswers && !formulaFormat)
        || !["1", "2", "3"].includes(toleranceType || "") || !/^[0-9]$/.test(answerLength || "") || !["1", "2"].includes(answerFormat || "")) return null;
      if (formula === "" && feedback === "" && /^-?0(?:[.,]0+)?$/.test(fraction)) continue;
      answers.push({ formula, ...(editorAnswers ? { formula_format: formulaFormat } : {}), fraction, tolerance, tolerance_type: toleranceType,
        correct_answer_length: answerLength, correct_answer_format: answerFormat, feedback, feedback_format: feedbackFormat });
    }
    return answers.length ? answers : null;
  };
  // A Calculated simple form carries its dataset definitions as "1-<category>-<name>". Category 0 is
  // private to this question; any other category is a wildcard shared with the question category.
  const calculatedDatasetDefinitions = (formData) => {
    const indexes = repeatedIndexes(formData, /^datasetdef\[([0-9]+)\]$/);
    if (!indexes.length || indexes.length > MAX_ITEMS || indexes.some((entry, index) => entry !== index + 1)) return null;
    const definitions = [];
    const keys = new Set();
    for (const index of indexes) {
      const value = oneFormValue(formData, `datasetdef[${index}]`, 1333);
      const match = value === null ? null : value.match(/^1-([0-9]+)-(.+)$/);
      if (!match || keys.has(value)) return null;
      keys.add(value);
      definitions.push({ key: value, name: match[2], shared: match[1] !== "0" });
    }
    return definitions;
  };
  // Every saved wildcard value carries the item id Moodle stored for it. A set the native "Generate
  // new item set" button produced has no stored id, so a missing id means the page is showing
  // generated values instead of the saved question.
  const calculatedDatasetValueSets = (formData, definitions) => {
    const keys = new Set(definitions.map((definition) => definition.key));
    const indexes = repeatedIndexes(formData, /^itemid\[([0-9]+)\]$/);
    if (!indexes.length || indexes.length > definitions.length * MAX_ITEMS || indexes.some((entry, index) => entry !== index + 1)
      || indexes.length % definitions.length !== 0) return null;
    for (const index of indexes) {
      const storedId = oneFormValue(formData, `itemid[${index}]`, 32);
      const definition = oneFormValue(formData, `definition[${index}]`, 1333);
      if (!id(storedId) || !definition || !keys.has(definition)) return null;
    }
    return indexes.length / definitions.length;
  };
  // The three calculated types are read on their first page only. Calculated and Calculated
  // multichoice keep their dataset definitions and items on later wizard pages, which this reader
  // never opens; Calculated simple keeps them on the same page, where the native buttons can also
  // add wildcards and generate new value sets before the question is saved.
  const calculatedFirstPage = (qtype, context, form, formData) => {
    if (/[?&]wizardnow=/i.test(String(form.getAttribute("action") || ""))) return false;
    const names = Array.from(form.querySelectorAll("[name]")).map((control) => String(control.getAttribute("name") || ""));
    if (names.some((name) => name === "wizardnow" || name === "forceregeneration" || name.startsWith("dataset["))) return false;
    if (qtype !== "calculatedsimple") {
      return namedControls(form, "wizard").length === 1 && oneFormValue(formData, "wizard", 32) === "datasetdefinitions"
        && !names.some((name) => /^(?:datasetdef|defoptions|number|itemid|definition|calcmin|calcmax|calclength|calcdistribution)\[/.test(name)
          || ["analyzequestion", "addbutton", "showbutton", "updatedatasets", "selectadd", "selectshow"].includes(name));
    }
    if (namedControls(form, "wizard").length) return false;
    const definitions = calculatedDatasetDefinitions(formData);
    const answers = calculatedAnswerRows(context, formData, qtype);
    if (!definitions || !answers || !calculatedDatasetValueSets(formData, definitions)) return false;
    const defined = new Set(definitions.map((definition) => definition.name));
    return calculatedWildcardNames(answers.map((answer) => answer.formula)).every((name) => defined.has(name));
  };
  const calculatedData = (qtype, context, form, formData) => {
    const answers = calculatedAnswerRows(context, formData, qtype);
    const synchronize = oneFormValue(formData, "synchronize", 32);
    if (!answers || !["0", "1", "2"].includes(synchronize || "")) return null;
    const wildcards = calculatedWildcardNames(answers.map((answer) => answer.formula));
    if (!wildcards.length) return null;
    if (qtype === "calculatedmulti") {
      const single = nativeBoolean(form, formData, "single");
      const shuffleAnswers = nativeBoolean(form, formData, "shuffleanswers");
      const answerNumbering = oneFormValue(formData, "answernumbering", 64);
      const defaults = multipleChoiceDefaults(context, form, formData);
      if (single === null || shuffleAnswers === null || !answerNumbering || !defaults) return null;
      return { shared_dataset_sync: synchronize, formula_wildcards: wildcards, single, shuffle_answers: shuffleAnswers, answer_numbering: answerNumbering, answers, ...defaults };
    }
    const units = numericalUnitData(formData);
    const interactive = interactiveQuestionData(context, form, formData);
    if (!units || !interactive) return null;
    if (qtype === "calculated") return { shared_dataset_sync: synchronize, formula_wildcards: wildcards, answers, ...units, ...interactive };
    const definitions = calculatedDatasetDefinitions(formData);
    const valueSets = definitions ? calculatedDatasetValueSets(formData, definitions) : null;
    if (!definitions || !valueSets) return null;
    return { shared_dataset_sync: synchronize, formula_wildcards: wildcards, dataset_definitions: definitions.map(({ name, shared }) => ({ name, shared })),
      dataset_value_sets: valueSets, answers, ...units, ...interactive };
  };
  const questionDetails = (qtype, context, form, formData) => {
    if (qtype === "multichoice") return multipleChoiceData(context, form, formData);
    if (qtype === "truefalse") return trueFalseData(context, form, formData);
    if (qtype === "shortanswer") return shortAnswerData(context, form, formData);
    if (qtype === "numerical") return numericalData(context, form, formData);
    if (qtype === "essay") return essayData(context, form, formData);
    if (qtype === "match") return matchData(context, form, formData);
    if (qtype === "ordering") return orderingData(context, form, formData);
    if (qtype === "randomsamatch") return randomSamatchData(context, form, formData);
    if (qtype === "description") return {};
    if (["gapselect", "ddwtos"].includes(qtype)) return gapselectData(qtype, context, form, formData);
    if (qtype === "ddimageortext") return dragImageData(context, form, formData);
    if (qtype === "ddmarker") return dragMarkerData(context, form, formData);
    if (qtype === "multianswer") return multianswerData(context, form, formData);
    if (calculatedQuestionTypes.has(qtype)) return calculatedData(qtype, context, form, formData);
    return null;
  };
  const getQuizQuestion = async (context, inputValue, args) => {
    const listed = await listQuizQuestions(context, inputValue, args);
    if (!listed.ok) return listed;
    const slot = listed.slots.find((entry) => entry.slot_id === Number(args.slot_id));
    if (!slot) return error(listed.data.truncated ? "moodle_quiz_slot_not_listed" : "moodle_quiz_slot_not_found");
    if (slot.reason === "random_slot") return error("moodle_quiz_random_slot_uninspectable");
    if (slot.reason === "unsupported_type") return error("moodle_question_type_unsupported");
    if (!slot.inspectable || !slot._questionId) return error("moodle_question_not_editable");
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const page = await loadQuizDocument(rechecked, "/question/bank/editquestion/question.php", { id: slot._questionId, cmid: args.module_id }, "moodle_question_read_failed");
    if (!page.ok) return page;
    const endpoint = urlFor(rechecked, "/question/bank/editquestion/question.php", { id: slot._questionId, cmid: args.module_id });
    const forms = Array.from(page.document.querySelectorAll("form")).filter((form) => {
      if (String(form.getAttribute("method") || "get").toLowerCase() !== "post") return false;
      try {
        const action = new URL(form.getAttribute("action") || endpoint, endpoint);
        const data = new FormData(form);
        return action.origin === rechecked.profile.origin && action.pathname === new URL(endpoint).pathname
          && oneFormValue(data, "id", 32) === slot._questionId && oneFormValue(data, "cmid", 32) === args.module_id
          && oneFormValue(data, "courseid", 32) === args.course_id;
      } catch { return false; }
    });
    if (forms.length !== 1) return { ...error("moodle_question_target_invalid"), status: page.status };
    let formData;
    let fileManagers;
    try { formData = new FormData(forms[0]); fileManagers = await inspectFileManagers(rechecked, forms[0], formData); } catch { return { ...error("moodle_question_target_invalid"), status: page.status }; }
    if (!nativeFormSesskey(rechecked, formData)) return { ...error("moodle_form_session_mismatch"), status: page.status };
    const qtype = oneFormValue(formData, "qtype", 64);
    if (qtype !== slot.qtype || !supportedQuestionTypes.has(qtype || "")) return { ...error("moodle_question_target_invalid"), status: page.status };
    if (calculatedQuestionTypes.has(qtype) && !calculatedFirstPage(qtype, rechecked, forms[0], formData)) return { ...error("moodle_question_dataset_wizard_pending"), status: page.status };
    const category = forms[0].querySelector('[name="category"]')
      ? questionCategory(forms[0], formData)
      : await savedQuestionCategory(rechecked, inputValue, args, slot._questionId, qtype);
    const common = questionCommonData(rechecked, formData, qtype);
    const tags = questionTagDefaults(formData);
    let details = questionDetails(qtype, rechecked, forms[0], formData);
    if (!category || !common || !tags || !details) return { ...error("moodle_question_content_refused"), status: page.status };
    if (dragToImageTypes.has(qtype)) {
      const background = await dragToImageBackground(rechecked, formData);
      if (!background) return { ...error("moodle_question_content_refused"), status: page.status };
      details = { ...details, background_image: background.file };
    }
    const data = sanitize({ course_id: Number(args.course_id), module_id: Number(args.module_id), slot_id: Number(args.slot_id), question_id: Number(slot._questionId), version: slot.version, qtype, question_bank: category, ...common, ...(qtype === "multianswer" ? { default_mark: details.total_mark } : {}), ...tags, details, ...(questionFileAreas(fileManagers).length ? { file_areas: questionFileAreas(fileManagers) } : {}) });
    return { ok: true, sent: true, status: page.status, data, targets: listed.targets, snapshot_digest: await digest(data) };
  };
  const nativeMark = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string" || !/^[0-9]+(?:[.,][0-9]+)?$/.test(value)) return null;
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  };
  const sameMark = (left, right) => {
    const leftValue = nativeMark(left);
    const rightValue = nativeMark(right);
    return leftValue !== null && rightValue !== null && Math.abs(leftValue - rightValue) < 1e-9;
  };
  const priorSlot = (slot) => ({
    slot_id: slot.slot_id, position: slot.position, qtype: slot.qtype, status: slot.status, version: slot.version || null,
    question_id: slot.question_id || null, name: slot.name || "", max_mark: slot.max_mark,
    inspectable: slot.inspectable, reason: slot.reason || "",
  });
  const samePriorSlots = (before, after) => before.length <= after.length
    && before.every((slot) => {
      const candidate = after.find((entry) => entry.slot_id === slot.slot_id);
      return candidate && stable(priorSlot(slot)) === stable(priorSlot(candidate));
    });
  const nativeFraction = (controls, requested) => {
    const match = controls?.fraction_options?.find((candidate) => sameMark(candidate, requested));
    return match || "";
  };
  const setQuestionCommonChanges = (form, args, creation) => {
    if ((creation || args.name !== undefined)) setField(form.formData, "name", args.name);
    if ((creation || args.question_text !== undefined)) setField(form.formData, "questiontext[text]", args.question_text);
    if (form.qtype !== "multianswer" && (creation || args.default_mark !== undefined)) setField(form.formData, "defaultmark", args.default_mark);
  };
  const setAnswerChanges = (form, answers, numerical = false) => {
    if (answers === undefined) return true;
    if (!Array.isArray(form.answerControls) || answers.length > form.answerControls.length) return false;
    for (let index = 0; index < form.answerControls.length; index += 1) {
      const answer = answers[index];
      const fraction = nativeFraction(form.answerControls[index], answer ? answer.grade_fraction : 0);
      if (!fraction) return false;
      setField(form.formData, `answer[${index}][text]`, answer ? answer.answer_text : "");
      setField(form.formData, `fraction[${index}]`, fraction);
      setField(form.formData, `feedback[${index}][text]`, answer ? answer.feedback : "");
      if (numerical) setField(form.formData, `tolerance[${index}]`, answer ? answer.tolerance : "0");
    }
    return true;
  };
  const questionFormChanges = (form, args, creation = false) => {
    setQuestionCommonChanges(form, args, creation);
    if (form.qtype === "multichoice") {
      if (args.answers === undefined) return !creation;
      if (!form.answerControls || args.answers.length > form.answerControls.length) return null;
      setField(form.formData, "single", "1");
      for (let index = 0; index < form.answerControls.length; index += 1) {
        const answer = args.answers[index];
        setField(form.formData, `answer[${index}][text]`, answer ? answer.answer_text : "");
        setField(form.formData, `fraction[${index}]`, answer?.correct_answer ? "1.0" : "0.0");
        setField(form.formData, `feedback[${index}][text]`, answer ? answer.feedback : "");
      }
      return true;
    }
    if (form.qtype === "truefalse") {
      if (creation || args.correct_answer !== undefined) {
        const selected = args.correct_answer ? "1" : "0";
        if (!form.answerControls || !form.answerControls.correct_answer_options?.includes(selected)) return null;
        setField(form.formData, "correctanswer", selected);
      }
      if (creation || args.true_feedback !== undefined) setField(form.formData, "feedbacktrue[text]", args.true_feedback);
      if (creation || args.false_feedback !== undefined) setField(form.formData, "feedbackfalse[text]", args.false_feedback);
      return true;
    }
    if (form.qtype === "shortanswer") {
      if (creation || args.case_sensitive !== undefined) {
        const options = availableSelectValues(form.document || { querySelectorAll: () => [] }, "usecase");
        const selected = args.case_sensitive ? "1" : "0";
        if (!options.includes(selected)) return null;
        setField(form.formData, "usecase", selected);
      }
      return setAnswerChanges(form, args.answers);
    }
    if (form.qtype === "numerical") {
      if (args.answers !== undefined) {
        const details = form.data?.defaults?.details || form.data?.details;
        if (details?.unit_role !== "0" || details.units?.length) return null;
      }
      return setAnswerChanges(form, args.answers, true);
    }
    if (["essay", "description", "multianswer"].includes(form.qtype)) return true;
    if (["gapselect", "ddwtos"].includes(form.qtype)) {
      if (!Array.isArray(form.answerControls) || !Array.isArray(args.choices) || args.choices.length > form.answerControls.length) return null;
      if (args.choices.some((choice, index) => !form.answerControls[index].group_options.includes(String(choice.group)))) return null;
      setField(form.formData, "shuffleanswers", args.shuffle_answers ? "1" : "0");
      for (let index = 0; index < form.answerControls.length; index += 1) {
        const choice = args.choices[index];
        setField(form.formData, `choices[${index}][answer]`, choice ? choice.text : "");
        if (choice) setField(form.formData, `choices[${index}][choicegroup]`, choice.group);
        if (form.qtype === "ddwtos") setField(form.formData, `choices[${index}][infinite]`, choice?.unlimited ? "1" : "0");
      }
      return true;
    }
    if (form.qtype === "match") {
      const changedPairs = args.pairs !== undefined || args.distractors !== undefined;
      if (!creation && !changedPairs && args.shuffle_answers === undefined) return true;
      if ((creation || changedPairs) && (!Array.isArray(args.pairs) || !Array.isArray(args.distractors) || args.pairs.length + args.distractors.length > form.answerControls.length)) return null;
      if (creation || args.shuffle_answers !== undefined) setField(form.formData, "shuffleanswers", args.shuffle_answers ? "1" : "0");
      if (creation || changedPairs) {
        const rows = [...args.pairs.map((entry) => ({ question: entry.question_text, answer: entry.answer_text })), ...args.distractors.map((answer) => ({ question: "", answer }))];
        for (let index = 0; index < form.answerControls.length; index += 1) {
          const row = rows[index];
          setField(form.formData, `subquestions[${index}][text]`, row ? row.question : "");
          setField(form.formData, `subanswers[${index}]`, row ? row.answer : "");
        }
      }
      return true;
    }
    return null;
  };
  const quizQuestionRedirectMatches = (context, redirectUrl, moduleId) => {
    let redirect;
    try { redirect = new URL(redirectUrl); } catch { return false; }
    const expected = new URL(urlFor(context, "/mod/quiz/edit.php"));
    const params = uniqueQuery(redirect);
    return redirect.origin === expected.origin && redirect.pathname === expected.pathname && params?.cmid === moduleId;
  };
  const questionCreationVerified = (before, after, question, args) => {
    const newSlots = after.slots.filter((slot) => !before.slots.some((entry) => entry.slot_id === slot.slot_id));
    if (after.slots.length !== before.slots.length + 1 || newSlots.length !== 1 || !samePriorSlots(before.slots, after.slots)) return null;
    const slot = newSlots[0];
    const requestedMark = requestedQuestionMark(before.qtype, args);
    if (requestedMark === null || slot.position !== before.slots.length + 1 || !slot.inspectable || slot.qtype !== before.qtype || !slot._questionId || !sameMark(slot.max_mark, requestedMark)) return null;
    const defaults = before.data.defaults;
    const matches = question.data.question_id === Number(slot._questionId)
      && question.data.qtype === before.qtype && question.data.name === args.name
      && question.data.question_text === args.question_text
      && question.data.question_text_format === defaults.question_text_format
      && question.data.status === defaults.status && sameMark(question.data.default_mark, requestedMark)
      && question.data.general_feedback === defaults.general_feedback
      && question.data.general_feedback_format === defaults.general_feedback_format
      && question.data.id_number === defaults.id_number
      && stable(question.data.tags) === stable(defaults.tags)
      && stable(question.data.course_tags) === stable(defaults.course_tags)
      && question.data.question_bank?.category_id === before.category.category_id
      && question.data.question_bank?.context_id === before.category.context_id;
    if (!matches) return null;
    if (before.qtype === "multichoice") {
      const expectedChoices = args.answers.map((answer, index) => ({
        text: answer.answer_text, format: before.answerControls[index].format,
        fraction: answer.correct_answer ? "1.0" : "0.0", feedback: answer.feedback,
        feedback_format: before.answerControls[index].feedback_format,
      }));
      return question.data.details?.single === true
        && question.data.details?.shuffle_answers === defaults.shuffle_answers
        && question.data.details?.answer_numbering === defaults.answer_numbering
        && question.data.details?.show_standard_instruction === defaults.show_standard_instruction
        && stable(question.data.details?.combined_feedback) === stable(defaults.combined_feedback)
        && sameMark(question.data.details?.penalty, defaults.penalty)
        && question.data.details?.show_num_correct === defaults.show_num_correct
        && stable(question.data.details?.hints) === stable(defaults.hints)
        && question.data.details?.choices_truncated === false
        && stable(question.data.details?.choices) === stable(expectedChoices) ? slot : null;
    }
    if (before.qtype === "truefalse") {
      return question.data.details?.correct_answer === args.correct_answer
        && question.data.details?.true_feedback === args.true_feedback && question.data.details?.true_feedback_format === before.answerControls.true_feedback_format
        && question.data.details?.false_feedback === args.false_feedback && question.data.details?.false_feedback_format === before.answerControls.false_feedback_format
        && question.data.details?.show_standard_instruction === defaults.details.show_standard_instruction
        && sameMark(question.data.details?.penalty, defaults.details.penalty) ? slot : null;
    }
    if (["shortanswer", "numerical"].includes(before.qtype)) {
      const numerical = before.qtype === "numerical";
      const expectedAnswers = args.answers.map((answer, index) => ({ text: answer.answer_text, format: before.answerControls[index].format,
        fraction: nativeFraction(before.answerControls[index], answer.grade_fraction), feedback: answer.feedback,
        feedback_format: before.answerControls[index].feedback_format, ...(numerical ? { tolerance: String(answer.tolerance) } : {}) }));
      const details = question.data.details;
      return stable(details?.answers) === stable(expectedAnswers)
        && (!numerical ? details?.case_sensitive === args.case_sensitive : stable({ unit_role: details?.unit_role, unit_penalty: details?.unit_penalty, unit_grading_type: details?.unit_grading_type, multiple_choice_display: details?.multiple_choice_display, units_left: details?.units_left, units: details?.units }) === stable({ unit_role: defaults.details.unit_role, unit_penalty: defaults.details.unit_penalty, unit_grading_type: defaults.details.unit_grading_type, multiple_choice_display: defaults.details.multiple_choice_display, units_left: defaults.details.units_left, units: defaults.details.units }))
        && sameMark(details?.penalty, defaults.details.penalty) && stable(details?.hints) === stable(defaults.details.hints) ? slot : null;
    }
    if (before.qtype === "essay") return stable(question.data.details) === stable(defaults.details) ? slot : null;
    if (before.qtype === "match") {
      const expectedPairs = args.pairs.map((pair, index) => ({ question_text: pair.question_text, question_text_format: before.answerControls[index].question_text_format, answer_text: pair.answer_text }));
      const details = question.data.details;
      return details?.shuffle_answers === args.shuffle_answers && stable(details?.pairs) === stable(expectedPairs)
        && stable(details?.distractors) === stable(args.distractors) && stable(details?.combined_feedback) === stable(defaults.details.combined_feedback)
        && sameMark(details?.penalty, defaults.details.penalty) && details?.show_num_correct === defaults.details.show_num_correct
        && stable(details?.hints) === stable(defaults.details.hints) ? slot : null;
    }
    if (before.qtype === "description") return stable(question.data.details) === stable({}) ? slot : null;
    if (["gapselect", "ddwtos"].includes(before.qtype)) {
      const details = question.data.details;
      return details?.shuffle_answers === args.shuffle_answers && stable(details?.choices) === stable(args.choices)
        && stable(details?.combined_feedback) === stable(defaults.details.combined_feedback)
        && sameMark(details?.penalty, defaults.details.penalty) && details?.show_num_correct === defaults.details.show_num_correct
        && stable(details?.hints) === stable(defaults.details.hints) ? slot : null;
    }
    if (before.qtype === "multianswer") {
      const parsed = multianswerSource(args.question_text);
      return parsed && question.data.details?.source_syntax === "shortanswer_exact"
        && stable(question.data.details?.parts) === stable(parsed.parts) && sameMark(question.data.details?.total_mark, parsed.total_mark)
        && sameMark(question.data.details?.penalty, defaults.details.penalty)
        && stable(question.data.details?.hints) === stable(defaults.details.hints) ? slot : null;
    }
    return null;
  };
  // Question-bank creation can affect random-question references beyond the reviewed Quiz.
  // Keep registered legacy schemas deterministic while refusing before any native request or POST.
  const runQuizQuestionCreation = async () => error("moodle_question_bank_impact_unresolved");
  const runQuizQuestionUpdate = async () => error("moodle_question_bank_impact_unresolved");
  const nativeSelectAllows = (documentValue, name, value) => {
    const controls = namedControls(documentValue, name).filter((control) => control.tagName === "SELECT");
    return controls.length === 1 && !controls[0].disabled && Array.from(controls[0].options || []).some((option) => String(option.value || "") === String(value));
  };
  const nativeTextWritable = (documentValue, name) => {
    const controls = namedControls(documentValue, name).filter((control) => ["INPUT", "TEXTAREA"].includes(control.tagName));
    return controls.length === 1 && !controls[0].disabled;
  };
  const nativeBooleanWritable = (documentValue, name, value) => {
    const controls = namedControls(documentValue, name);
    const checkboxes = controls.filter((control) => String(control.getAttribute("type") || "").toLowerCase() === "checkbox");
    if (checkboxes.length === 1 && controls.every((control) => control === checkboxes[0] || String(control.getAttribute("type") || "").toLowerCase() === "hidden")) return !checkboxes[0].disabled;
    return nativeSelectAllows(documentValue, name, value ? "1" : "0");
  };
  const choiceOptionIndexes = (formData) => [...new Set(Array.from(formData.keys()).map((name) => name.match(/^option\[([0-9]+)\]$/)).filter(Boolean).map((match) => Number(match[1])))].sort((left, right) => left - right);
  const choiceNativeWritable = (form, options) => {
    const indexes = choiceOptionIndexes(form.formData);
    return options.length <= indexes.length && indexes.length >= 1 && indexes.every((index) => nativeTextWritable(form.document, `option[${index}]`) && nativeTextWritable(form.document, `limit[${index}]`));
  };
  const forumWriteAllowed = (form, args) => {
    if (args.forum_type !== undefined && !nativeSelectAllows(form.document, "type", args.forum_type)) return false;
    if (args.subscription_mode !== undefined && !nativeSelectAllows(form.document, "forcesubscribe", args.subscription_mode)) return false;
    if (args.tracking_type !== undefined && !nativeSelectAllows(form.document, "trackingtype", args.tracking_type)) return false;
    return args.assessment === undefined || (nativeSelectAllows(form.document, "grade_forum[modgrade_type]", args.assessment.type)
      && (args.assessment.type !== "point" || nativeTextWritable(form.document, "grade_forum[modgrade_point]")));
  };
  const choiceWriteAllowed = (form, args) => {
    const selectArguments = [["display", args.display], ["showresults", args.show_results], ["publish", args.publish_names]];
    const booleanArguments = [["allowupdate", args.allow_update], ["allowmultiple", args.allow_multiple], ["limitanswers", args.limit_answers], ["showavailable", args.show_available], ["showpreview", args.show_preview], ["showunanswered", args.show_unanswered], ["includeinactive", args.include_inactive]];
    if (selectArguments.some(([name, value]) => value !== undefined && !nativeSelectAllows(form.document, name, value))) return false;
    if (booleanArguments.some(([name, value]) => value !== undefined && !nativeBooleanWritable(form.document, name, value))) return false;
    return args.options === undefined || choiceNativeWritable(form, args.options);
  };
  const glossaryWriteAllowed = (form, args) => (args.default_approval === undefined || nativeBooleanWritable(form.document, "defaultapproval", args.default_approval))
    && (args.allow_comments === undefined || nativeBooleanWritable(form.document, "allowcomments", args.allow_comments));
  const wikiWriteAllowed = (form, args, creation = false) => (args.default_format === undefined || nativeSelectAllows(form.document, "defaultformat", args.default_format))
    && (args.force_format === undefined || nativeBooleanWritable(form.document, "forceformat", args.force_format))
    && (!creation || (nativeSelectAllows(form.document, "wikimode", args.wiki_mode) && nativeTextWritable(form.document, "firstpagetitle")));
  const feedbackWriteAllowed = (form, args) => args.anonymous === undefined || nativeSelectAllows(form.document, "anonymous", args.anonymous);
  const dataWriteAllowed = (form, args) => args.approval === undefined || nativeBooleanWritable(form.document, "approval", args.approval);
  const setAssignmentSetting = (formData, setting, value) => {
    if (setting.kind === "count") {
      if (value === null) formData.delete(setting.enabledField);
      else {
        setField(formData, setting.enabledField, 1);
        setField(formData, setting.field, value);
      }
      return [setting.field, setting.enabledField];
    }
    setField(formData, setting.field, setting.kind === "boolean" ? (value ? 1 : 0) : value);
    return [setting.field];
  };
  const setAssignmentGrade = (formData, grade) => {
    setField(formData, "grade[modgrade_type]", grade.type);
    if (grade.type === "point") setField(formData, "grade[modgrade_point]", grade.maximum_points);
    if (grade.type === "scale") setField(formData, "grade[modgrade_scale]", grade.scale);
    return ["grade[modgrade_type]", "grade[modgrade_point]", "grade[modgrade_scale]"];
  };
  const assignmentWriteAllowed = (form, args) => {
    if (assignmentSubmissionArguments.some((argument) => args[argument] !== undefined) && assignmentSubmissionsFrozen(form.document, form.values)) return "moodle_assignment_submissions_exist";
    for (const setting of assignmentSettings) {
      const value = args[setting.argument];
      if (value === undefined) continue;
      const writable = setting.kind === "boolean" ? nativeBooleanWritable(form.document, setting.field, value)
        : setting.kind === "select" ? nativeSelectAllows(form.document, setting.field, value)
          : setting.kind === "count" ? nativeTextWritable(form.document, setting.field) && nativeBooleanWritable(form.document, setting.enabledField, value !== null)
            : nativeTextWritable(form.document, setting.field);
      if (!writable) return "moodle_assignment_native_setting_refused";
    }
    if (args.grade !== undefined && !(nativeSelectAllows(form.document, "grade[modgrade_type]", args.grade.type)
      && (args.grade.type !== "point" || nativeTextWritable(form.document, "grade[modgrade_point]"))
      && (args.grade.type !== "scale" || nativeSelectAllows(form.document, "grade[modgrade_scale]", args.grade.scale)))) return "moodle_assignment_native_setting_refused";
    return "";
  };
  const setDuration = (formData, name, seconds) => {
    if (seconds === null) formData.delete(`${name}[enabled]`);
    else {
      setField(formData, `${name}[enabled]`, 1);
      setField(formData, `${name}[number]`, seconds);
      setField(formData, `${name}[timeunit]`, 1);
    }
    return [`${name}[enabled]`, `${name}[number]`, `${name}[timeunit]`];
  };
  const nativeDurationWritable = (documentValue, name, seconds) => nativeBooleanWritable(documentValue, `${name}[enabled]`, seconds !== null)
    && (seconds === null || (nativeTextWritable(documentValue, `${name}[number]`) && nativeSelectAllows(documentValue, `${name}[timeunit]`, "1")));
  const setQuizSetting = (formData, setting, value) => {
    if (setting.kind === "duration") return setDuration(formData, setting.field, value);
    setField(formData, setting.field, setting.kind === "boolean" ? (value ? 1 : 0) : value);
    return [setting.field];
  };
  const setQuizReviewOptions = (formData, options) => {
    const names = [];
    for (const { argument, field } of quizReviewFields) {
      for (const when of quizReviewWhens) {
        const name = `${field}${when}`;
        if (options[argument][when]) setField(formData, name, 1);
        else formData.delete(name);
        names.push(name);
      }
    }
    return names;
  };
  const quizReviewOptionsWritable = (documentValue, options) => quizReviewFields.every(({ argument, field }) => quizReviewWhens
    .every((when) => nativeBooleanWritable(documentValue, `${field}${when}`, options[argument][when])));
  const quizReviewOptionFixed = (options) => quizFixedReviewOptions.some(({ argument, when, value }) => options[argument][when] !== value);
  const quizFeedbackWritable = (form, bands) => {
    const rows = quizFeedbackRowNames(Object.keys(form.values));
    if (!rows || bands.length > rows.length) return false;
    return rows.every((row) => nativeTextWritable(form.document, `feedbacktext[${row.index}][text]`)
      && (!row.boundary || nativeTextWritable(form.document, `feedbackboundaries[${row.index}]`)));
  };
  const setQuizFeedbackBands = (formData, bands) => {
    const names = [];
    for (const row of quizFeedbackRowNames([...formData.keys()]) || []) {
      const band = bands[row.index];
      setField(formData, `feedbacktext[${row.index}][text]`, band ? band.feedback : "");
      names.push(`feedbacktext[${row.index}][text]`);
      if (!row.boundary) continue;
      setField(formData, `feedbackboundaries[${row.index}]`, band && band.lower_boundary !== null ? band.lower_boundary : "");
      names.push(`feedbackboundaries[${row.index}]`);
    }
    return names;
  };
  // A Quiz that requires Safe Exam Browser is an exam whose access rules Morrow
  // does not read or carry, so no settings change is sent to it at all.
  const quizWriteAllowed = (form, args) => {
    const safeExamBrowser = controlValue(form.document, form.values, "seb_requiresafeexambrowser");
    if (safeExamBrowser && safeExamBrowser !== "0") return "moodle_quiz_seb_settings_refused";
    for (const setting of quizSettings) {
      const value = args[setting.argument];
      if (value === undefined) continue;
      const writable = setting.kind === "boolean" ? nativeBooleanWritable(form.document, setting.field, value)
        : setting.kind === "select" ? nativeSelectAllows(form.document, setting.field, value)
          : setting.kind === "duration" ? nativeDurationWritable(form.document, setting.field, value)
            : nativeTextWritable(form.document, setting.field);
      if (!writable) return "moodle_quiz_native_setting_refused";
    }
    if (args.review_options !== undefined) {
      if (quizReviewOptionFixed(args.review_options)) return "moodle_quiz_review_option_fixed";
      if (!quizReviewOptionsWritable(form.document, args.review_options)) return "moodle_quiz_native_setting_refused";
    }
    if (args.overall_feedback_bands !== undefined && !quizFeedbackWritable(form, args.overall_feedback_bands)) return "moodle_quiz_feedback_rows_unavailable";
    if (args.password !== undefined && !nativeTextWritable(form.document, "quizpassword")) return "moodle_quiz_native_setting_refused";
    return "";
  };
  const setChoiceOptions = (formData, options, limits) => {
    const indexes = choiceOptionIndexes(formData);
    for (const [position, index] of indexes.entries()) {
      setField(formData, `option[${index}]`, options[position] || "");
      setField(formData, `limit[${index}]`, limits[position] || 0);
    }
    return indexes.flatMap((index) => [`option[${index}]`, `limit[${index}]`, `optionid[${index}]`]);
  };
  const formChanges = (kind, args, formData) => {
    const names = [];
    if (kind === "course-form-write") { setField(formData, "summary_editor[text]", args.summary); names.push("summary_editor[text]"); }
    if (kind === "section-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.summary !== undefined) { setField(formData, "summary_editor[text]", args.summary); names.push("summary_editor[text]"); }
    }
    if (kind === "page-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.content !== undefined) { setField(formData, "page[text]", args.content); names.push("page[text]"); }
    }
    if (kind === "label-form-write") { setField(formData, "introeditor[text]", args.content); names.push("introeditor[text]"); }
    if (kind === "url-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.external_url !== undefined) { setField(formData, "externalurl", args.external_url); names.push("externalurl"); }
      if (args.description !== undefined) { setField(formData, "introeditor[text]", args.description); names.push("introeditor[text]"); }
    }
    if (kind === "forum-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.instructions !== undefined) { setField(formData, "introeditor[text]", args.instructions); names.push("introeditor[text]"); }
      if (args.forum_type !== undefined) { setField(formData, "type", args.forum_type); names.push("type"); }
      if (args.subscription_mode !== undefined) { setField(formData, "forcesubscribe", args.subscription_mode); names.push("forcesubscribe"); }
      if (args.tracking_type !== undefined) { setField(formData, "trackingtype", args.tracking_type); names.push("trackingtype"); }
      if (args.assessment !== undefined) {
        setField(formData, "grade_forum[modgrade_type]", args.assessment.type);
        if (args.assessment.type === "point") setField(formData, "grade_forum[modgrade_point]", args.assessment.maximum_points);
        names.push("grade_forum[modgrade_type]", "grade_forum[modgrade_point]");
      }
      if (args.due_date !== undefined) { setDate(formData, "duedate", args.due_date); names.push(...dateFieldNames("duedate")); }
      if (args.cutoff_at !== undefined) { setDate(formData, "cutoffdate", args.cutoff_at); names.push(...dateFieldNames("cutoffdate")); }
    }
    if (kind === "choice-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.instructions !== undefined) { setField(formData, "introeditor[text]", args.instructions); names.push("introeditor[text]"); }
      for (const [field, argument] of [["display", "display"], ["allowupdate", "allow_update"], ["allowmultiple", "allow_multiple"], ["limitanswers", "limit_answers"], ["showavailable", "show_available"], ["showpreview", "show_preview"], ["showresults", "show_results"], ["publish", "publish_names"], ["showunanswered", "show_unanswered"], ["includeinactive", "include_inactive"]]) {
        if (args[argument] !== undefined) { setField(formData, field, typeof args[argument] === "boolean" ? (args[argument] ? 1 : 0) : args[argument]); names.push(field); }
      }
      if (args.options !== undefined) names.push(...setChoiceOptions(formData, args.options, args.limits));
      if (args.open_at !== undefined) { setDate(formData, "timeopen", args.open_at); names.push(...dateFieldNames("timeopen")); }
      if (args.close_at !== undefined) { setDate(formData, "timeclose", args.close_at); names.push(...dateFieldNames("timeclose")); }
    }
    if (kind === "book-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.instructions !== undefined) { setField(formData, "introeditor[text]", args.instructions); names.push("introeditor[text]"); }
      if (args.numbering !== undefined) { setField(formData, "numbering", args.numbering); names.push("numbering"); }
      if (args.custom_titles !== undefined) { setField(formData, "customtitles", args.custom_titles ? 1 : 0); names.push("customtitles"); }
    }
    if (kind === "lesson-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.instructions !== undefined) { setField(formData, "introeditor[text]", args.instructions); names.push("introeditor[text]"); }
      if (args.available_from !== undefined) { setDate(formData, "available", args.available_from); names.push(...dateFieldNames("available")); }
      if (args.deadline !== undefined) { setDate(formData, "deadline", args.deadline); names.push(...dateFieldNames("deadline")); }
    }
    if (kind === "glossary-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.instructions !== undefined) { setField(formData, "introeditor[text]", args.instructions); names.push("introeditor[text]"); }
      if (args.default_approval !== undefined) { setField(formData, "defaultapproval", args.default_approval ? 1 : 0); names.push("defaultapproval"); }
      if (args.allow_comments !== undefined) { setField(formData, "allowcomments", args.allow_comments ? 1 : 0); names.push("allowcomments"); }
    }
    if (kind === "wiki-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.instructions !== undefined) { setField(formData, "introeditor[text]", args.instructions); names.push("introeditor[text]"); }
      if (args.default_format !== undefined) { setField(formData, "defaultformat", args.default_format); names.push("defaultformat"); }
      if (args.force_format !== undefined) { setField(formData, "forceformat", args.force_format ? 1 : 0); names.push("forceformat"); }
    }
    if (kind === "feedback-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.instructions !== undefined) { setField(formData, "introeditor[text]", args.instructions); names.push("introeditor[text]"); }
      if (args.anonymous !== undefined) { setField(formData, "anonymous", args.anonymous); names.push("anonymous"); }
      if (args.open_at !== undefined) { setDate(formData, "timeopen", args.open_at); names.push(...dateFieldNames("timeopen")); }
      if (args.close_at !== undefined) { setDate(formData, "timeclose", args.close_at); names.push(...dateFieldNames("timeclose")); }
    }
    if (kind === "data-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.instructions !== undefined) { setField(formData, "introeditor[text]", args.instructions); names.push("introeditor[text]"); }
      if (args.approval !== undefined) { setField(formData, "approval", args.approval ? 1 : 0); names.push("approval"); }
      if (args.available_from !== undefined) { setDate(formData, "timeavailablefrom", args.available_from); names.push(...dateFieldNames("timeavailablefrom")); }
      if (args.available_to !== undefined) { setDate(formData, "timeavailableto", args.available_to); names.push(...dateFieldNames("timeavailableto")); }
    }
    const creationModuleName = creationModule(kind);
    if (creationModuleName) {
      const spec = creationSpec[creationModuleName];
      setField(formData, "name", args.name);
      setField(formData, spec.body, args[spec.dataBody]);
      for (const specField of spec.fields || []) setField(formData, specField.field, specField.kind === "boolean" ? (args[specField.argument] ? 1 : 0) : args[specField.argument]);
      setField(formData, "visible", 0);
      formData.delete("coursecontentnotification");
      names.push("name", spec.body, "visible");
      for (const { field } of spec.fields || []) names.push(field);
      for (const { argument, field } of spec.dates) {
        setDate(formData, field, args[argument]);
        names.push(...dateFieldNames(field));
      }
      if (creationModuleName === "forum") {
        setField(formData, "type", args.forum_type);
        setField(formData, "forcesubscribe", args.subscription_mode);
        setField(formData, "trackingtype", args.tracking_type);
        setField(formData, "grade_forum[modgrade_type]", args.assessment.type);
        if (args.assessment.type === "point") setField(formData, "grade_forum[modgrade_point]", args.assessment.maximum_points);
        names.push("type", "forcesubscribe", "trackingtype", "grade_forum[modgrade_type]", "grade_forum[modgrade_point]");
      }
      if (creationModuleName === "choice") {
        for (const [field, argument] of [["display", "display"], ["allowupdate", "allow_update"], ["allowmultiple", "allow_multiple"], ["limitanswers", "limit_answers"], ["showavailable", "show_available"], ["showpreview", "show_preview"], ["showresults", "show_results"], ["publish", "publish_names"], ["showunanswered", "show_unanswered"], ["includeinactive", "include_inactive"]]) {
          setField(formData, field, typeof args[argument] === "boolean" ? (args[argument] ? 1 : 0) : args[argument]);
          names.push(field);
        }
        names.push(...setChoiceOptions(formData, args.options, args.limits));
      }
      if (creationModuleName === "book") {
        setField(formData, "customtitles", args.custom_titles ? 1 : 0);
        names.push("customtitles");
      }
    }
    if (kind === "assignment-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.instructions !== undefined) { setField(formData, "introeditor[text]", args.instructions); names.push("introeditor[text]"); }
      for (const { argument, field } of assignmentDateFields) {
        if (args[argument] === undefined) continue;
        setDate(formData, field, args[argument]);
        names.push(...dateFieldNames(field));
      }
      for (const setting of assignmentSettings) {
        if (args[setting.argument] === undefined) continue;
        names.push(...setAssignmentSetting(formData, setting, args[setting.argument]));
      }
      if (args.grade !== undefined) names.push(...setAssignmentGrade(formData, args.grade));
    }
    if (["assignment-override-create", "assignment-override-write", "quiz-override-create", "quiz-override-write"].includes(kind)) {
      for (const { argument, field, kind: fieldKind } of overrideSpec[overrideModule(kind)].fields) {
        if (fieldKind === "date") { setDate(formData, field, args[argument]); names.push(...dateFieldNames(field)); }
        else if (fieldKind === "duration") names.push(...setDuration(formData, field, args[argument]));
        else { setField(formData, field, args[argument]); names.push(field); }
      }
      if (kind.endsWith("-create")) {
        const field = args.group_id === undefined ? "userid" : "groupid";
        setField(formData, field, args.group_id === undefined ? args.user_id : args.group_id);
        names.push(field);
      }
    }
    if (kind === "quiz-form-write") {
      if (args.name !== undefined) { setField(formData, "name", args.name); names.push("name"); }
      if (args.instructions !== undefined) { setField(formData, "introeditor[text]", args.instructions); names.push("introeditor[text]"); }
      for (const { argument, field } of quizDateFields) {
        if (args[argument] === undefined) continue;
        setDate(formData, field, args[argument]);
        names.push(...dateFieldNames(field));
      }
      for (const setting of quizSettings) {
        if (args[setting.argument] === undefined) continue;
        names.push(...setQuizSetting(formData, setting, args[setting.argument]));
      }
      if (args.review_options !== undefined) names.push(...setQuizReviewOptions(formData, args.review_options));
      if (args.overall_feedback_bands !== undefined) names.push(...setQuizFeedbackBands(formData, args.overall_feedback_bands));
      if (args.password !== undefined) { setField(formData, "quizpassword", ""); names.push("quizpassword"); }
    }
    if (kind === "course-show" || kind === "course-hide") { setField(formData, "visible", kind === "course-show" ? 1 : 0); names.push("visible"); }
    return names;
  };
  // A native checkbox that is not ticked, and a secret control, are absent from
  // the form values, so the protected digest cannot see them change. The Quiz
  // review matrix and the Quiz password are therefore compared against the form
  // Morrow read before the write, even when the write did not name them.
  const expectedFormData = (kind, args, data, before = null) => {
    if (kind === "course-form-write") return data.summary === args.summary;
    if (kind === "section-form-write") return (args.name === undefined || data.name === args.name) && (args.summary === undefined || data.summary === args.summary);
    if (kind === "page-form-write") return (args.name === undefined || data.name === args.name) && (args.content === undefined || data.content === args.content);
    if (kind === "label-form-write") return data.content === args.content;
    if (kind === "url-form-write") return (args.name === undefined || data.name === args.name)
      && (args.external_url === undefined || data.external_url === nativeUrlValue(args.external_url))
      && (args.description === undefined || data.description === args.description);
    if (kind === "forum-form-write") return (args.name === undefined || data.name === args.name)
      && (args.instructions === undefined || data.instructions === args.instructions)
      && (args.forum_type === undefined || data.forum_type === args.forum_type)
      && (args.subscription_mode === undefined || data.subscription_mode === args.subscription_mode)
      && (args.tracking_type === undefined || data.tracking_type === args.tracking_type)
      && (args.assessment === undefined || stable(data.assessment) === stable(args.assessment))
      && (args.due_date === undefined || stable(data.due_date) === stable(args.due_date))
      && (args.cutoff_at === undefined || stable(data.cutoff_at) === stable(args.cutoff_at));
    if (kind === "choice-form-write") return (args.name === undefined || data.name === args.name)
      && (args.instructions === undefined || data.instructions === args.instructions)
      && (args.display === undefined || data.display === args.display)
      && (args.allow_update === undefined || data.allow_update === args.allow_update)
      && (args.allow_multiple === undefined || data.allow_multiple === args.allow_multiple)
      && (args.limit_answers === undefined || data.limit_answers === args.limit_answers)
      && (args.show_available === undefined || data.show_available === args.show_available)
      && (args.options === undefined || stable(data.options) === stable(args.options))
      && (args.limits === undefined || stable(data.limits) === stable(args.limits))
      && (args.open_at === undefined || stable(data.open_at) === stable(args.open_at))
      && (args.close_at === undefined || stable(data.close_at) === stable(args.close_at))
      && (args.show_preview === undefined || data.show_preview === args.show_preview)
      && (args.show_results === undefined || data.show_results === args.show_results)
      && (args.publish_names === undefined || data.publish_names === args.publish_names)
      && (args.show_unanswered === undefined || data.show_unanswered === args.show_unanswered)
      && (args.include_inactive === undefined || data.include_inactive === args.include_inactive);
    if (kind === "book-form-write") return (args.name === undefined || data.name === args.name)
      && (args.instructions === undefined || data.instructions === args.instructions)
      && (args.numbering === undefined || data.numbering === args.numbering)
      && (args.custom_titles === undefined || data.custom_titles === args.custom_titles);
    if (kind === "lesson-form-write") return (args.name === undefined || data.name === args.name)
      && (args.instructions === undefined || data.instructions === args.instructions)
      && (args.available_from === undefined || stable(data.available_from) === stable(args.available_from))
      && (args.deadline === undefined || stable(data.deadline) === stable(args.deadline));
    if (kind === "glossary-form-write") return (args.name === undefined || data.name === args.name)
      && (args.instructions === undefined || data.instructions === args.instructions)
      && (args.default_approval === undefined || data.default_approval === args.default_approval)
      && (args.allow_comments === undefined || data.allow_comments === args.allow_comments);
    if (kind === "wiki-form-write") return (args.name === undefined || data.name === args.name)
      && (args.instructions === undefined || data.instructions === args.instructions)
      && (args.default_format === undefined || data.default_format === args.default_format)
      && (args.force_format === undefined || data.force_format === args.force_format);
    if (kind === "feedback-form-write") return (args.name === undefined || data.name === args.name)
      && (args.instructions === undefined || data.instructions === args.instructions)
      && (args.anonymous === undefined || data.anonymous === args.anonymous)
      && (args.open_at === undefined || stable(data.open_at) === stable(args.open_at))
      && (args.close_at === undefined || stable(data.close_at) === stable(args.close_at));
    if (kind === "data-form-write") return (args.name === undefined || data.name === args.name)
      && (args.instructions === undefined || data.instructions === args.instructions)
      && (args.approval === undefined || data.approval === args.approval)
      && (args.available_from === undefined || stable(data.available_from) === stable(args.available_from))
      && (args.available_to === undefined || stable(data.available_to) === stable(args.available_to));
    if (kind === "assignment-form-write") return (args.name === undefined || data.name === args.name)
      && (args.instructions === undefined || data.instructions === args.instructions)
      && assignmentDateFields.every(({ argument }) => args[argument] === undefined || stable(data[argument]) === stable(args[argument]))
      && (args.grade === undefined || stable(data.grade) === stable(args.grade))
      && assignmentSettings.every((setting) => args[setting.argument] === undefined || stable(data[setting.argument]) === stable(args[setting.argument]));
    if (kind === "quiz-form-write") return (args.name === undefined || data.name === args.name)
      && (args.instructions === undefined || data.instructions === args.instructions)
      && quizDateFields.every(({ argument }) => args[argument] === undefined || stable(data[argument]) === stable(args[argument]))
      && quizSettings.every((setting) => args[setting.argument] === undefined || stable(data[setting.argument]) === stable(args[setting.argument]))
      && (args.review_options === undefined || stable(data.review_options) === stable(args.review_options))
      && (args.overall_feedback_bands === undefined || stable(data.overall_feedback_bands) === stable(args.overall_feedback_bands))
      && (args.password === undefined || data.password_set === false)
      && (!before || args.review_options !== undefined || stable(data.review_options) === stable(before.review_options))
      && (!before || args.password !== undefined || data.password_set === before.password_set);
    if (kind === "course-show") return data.visible === true;
    return data.visible === false;
  };
  // The native override pages of the bound module. The list route is fixed, and
  // every override edit route is the same page with the exact override ID. The
  // route that adds an override is taken from the list page itself, because only
  // the page states how Moodle spells that action for this site.
  const overrideReferences = (documentValue, pageUrl, context, module) => {
    const modulePath = `${context.basePath}/mod/${module}/`;
    const references = [];
    const add = (raw, extra = []) => {
      let url;
      try { url = new URL(raw, pageUrl); } catch { return; }
      if (url.origin !== context.profile.origin) return;
      if (url.pathname !== `${modulePath}overrideedit.php` && url.pathname !== `${modulePath}overridedelete.php`) return;
      for (const [name, value] of extra) url.searchParams.append(name, value);
      references.push({
        edit: url.pathname === `${modulePath}overrideedit.php`,
        params: Object.fromEntries(url.searchParams.entries()),
        names: [...url.searchParams.keys()],
      });
    };
    for (const anchor of documentValue.querySelectorAll("a[href]")) add(anchor.getAttribute("href") || "");
    for (const form of documentValue.querySelectorAll("form[action]")) {
      const hidden = Array.from(form.querySelectorAll('input[type="hidden"][name]'))
        .map((input) => [String(input.getAttribute("name") || ""), String(input.getAttribute("value") || "")])
        .filter(([name]) => name && !transientField(name));
      add(form.getAttribute("action") || "", hidden);
    }
    return references;
  };
  const overrideDescriptor = (context, { module, courseId, moduleId, scope, overrideId = "", addRoute = null }) => {
    const spec = overrideSpec[module];
    const route = overrideId ? { id: overrideId } : { ...addRoute };
    return {
      type: spec.type, module, scope, expectedPath: `/mod/${module}/overrideedit.php`,
      endpoint: urlFor(context, `/mod/${module}/overrideedit.php`, route),
      expected: { [spec.formIdentity]: "1" },
      required: [scope === "group" ? "groupid" : "userid", ...spec.fields.map(({ field, kind }) => kind === "select" ? field : `${field}[enabled]`)],
      courseId, moduleId, overrideId, strictIdentity: true, submitName: "submitbutton", actionRoute: route, finalRoute: route,
    };
  };
  const overrideListing = async (context, module, moduleId, scope) => {
    const failure = `moodle_${overrideSpec[module].noun}_overrides_read_failed`;
    const route = { cmid: moduleId, mode: scope };
    const endpoint = urlFor(context, `/mod/${module}/overrides.php`, route);
    let response;
    try { response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", headers: { Accept: "text/html" } }); } catch { return error(failure); }
    let text;
    try { text = await readText(response); } catch { return { ...error(failure), status: response.status }; }
    if (!response.ok || typeof DOMParser === "undefined" || !finalRouteMatches(response.url, endpoint, route)) return { ...error(failure), status: response.status };
    let documentValue;
    try { documentValue = new DOMParser().parseFromString(text, "text/html"); } catch { return { ...error(failure), status: response.status }; }
    const references = overrideReferences(documentValue, endpoint, context, module);
    const ids = [];
    for (const reference of references) {
      const overrideId = id(reference.params.id);
      if (!overrideId || ids.includes(overrideId)) continue;
      ids.push(overrideId);
    }
    const additions = references.filter((reference) => reference.edit && reference.params.id === undefined
      && id(reference.params.cmid) === moduleId
      && new Set(reference.names).size === reference.names.length
      && reference.names.every((name) => ["cmid", "action"].includes(name)));
    const heading = documentValue.querySelector("h1, h2");
    return {
      ok: true, sent: true, status: response.status, ids,
      addRoute: additions.length === 1 ? additions[0].params : null,
      name: String(heading?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 500),
    };
  };
  const overridesState = async (context, module, courseId, moduleId) => {
    const listings = {};
    for (const scope of ["user", "group"]) {
      const listing = await overrideListing(context, module, moduleId, scope);
      if (!listing.ok) return listing;
      listings[scope] = listing;
    }
    const complete = listings.user.ids.length + listings.group.ids.length <= OVERRIDE_LIMIT;
    const entries = [];
    if (complete) {
      for (const scope of ["user", "group"]) {
        for (const overrideId of listings[scope].ids) {
          const form = await loadForm(context, overrideDescriptor(context, { module, courseId, moduleId, scope, overrideId }));
          if (!form.ok) return form;
          entries.push({ overrideId, scope, data: form.data, values: form.values, target: controlValue(form.document, form.values, scope === "group" ? "groupid" : "userid") });
        }
      }
    }
    const data = {
      course_id: Number(courseId), module_id: Number(moduleId),
      overrides: entries.map((entry) => entry.data),
      user_override_count: listings.user.ids.length,
      group_override_count: listings.group.ids.length,
      complete,
    };
    return {
      ok: true, sent: true, status: listings.user.status, data, entries,
      addRoutes: { user: listings.user.addRoute, group: listings.group.addRoute },
      name: listings.user.name || listings.group.name,
      snapshot_digest: await digest(data),
    };
  };
  const overrideTargets = (context, module, name, scope, data) => [
    courseTarget(context),
    { field: "module_id", label: overrideSpec[module].label, name: String(name || data.module_id) },
    ...(scope === "group"
      ? [{ field: "group_id", label: "Group override", name: String(data.group_name || data.group_id || "Selected group") }]
      : scope === "user" ? [{ field: "user_id", label: "User override", name: "One Moodle user" }] : []),
  ];
  const runOverrideWrite = async (context, inputValue, definition, args) => {
    const module = overrideModule(definition.kind);
    const spec = overrideSpec[module];
    const creation = definition.kind.endsWith("-create");
    const scope = args.group_id === undefined ? "user" : "group";
    const targetField = scope === "group" ? "groupid" : "userid";
    const targetValue = scope === "group" ? args.group_id : args.user_id;
    const before = await overridesState(context, module, args.course_id, args.module_id);
    if (!before.ok) return before;
    if (!before.data.complete) return error(`moodle_${spec.noun}_overrides_incomplete`);
    if (before.snapshot_digest !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    const existing = creation ? null : before.entries.find((entry) => entry.overrideId === args.override_id);
    if (!creation && (!existing || existing.scope !== scope)) return error(`moodle_${spec.noun}_override_not_found`);
    if (creation && !before.addRoutes[scope]) return error(`moodle_${spec.noun}_override_route_unavailable`);
    const descriptor = overrideDescriptor(context, {
      module, courseId: args.course_id, moduleId: args.module_id, scope,
      overrideId: creation ? "" : args.override_id, addRoute: before.addRoutes[scope],
    });
    const form = await loadForm(context, descriptor);
    if (!form.ok) return form;
    const currentTarget = controlValue(form.document, form.values, targetField);
    if (creation ? !nativeSelectAllows(form.document, targetField, targetValue) : currentTarget !== targetValue) return error(`moodle_${spec.noun}_override_target_mismatch`);
    const refused = spec.fields.some(({ argument, field, kind }) => kind === "select" ? !nativeSelectAllows(form.document, field, args[argument])
      : kind === "duration" ? !nativeDurationWritable(form.document, field, args[argument]) : false);
    if (refused) return error(`moodle_${spec.noun}_override_setting_refused`);
    const names = formChanges(definition.kind, args, form.formData);
    const beforeProtected = await protectedDigest(form.values, names);
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const posted = await postForm(form);
    if (!posted.ok) return posted;
    const after = await overridesState(rechecked, module, args.course_id, args.module_id);
    const unconfirmed = { ok: false, sent: true, status: posted.status, outcomeUnknown: true, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_readback_unconfirmed" }, error: "moodle_readback_unconfirmed" };
    if (!after.ok || !after.data.complete) return unconfirmed;
    const priorIds = new Set(before.entries.map((entry) => entry.overrideId));
    const written = creation
      ? after.entries.filter((entry) => !priorIds.has(entry.overrideId))
      : after.entries.filter((entry) => entry.overrideId === args.override_id);
    const target = written.length === 1 ? written[0] : null;
    const untouched = (entries) => entries.filter((entry) => !written.some((changed) => changed.overrideId === entry.overrideId)).map((entry) => entry.data);
    const matches = Boolean(target) && target.scope === scope && target.target === targetValue
      && spec.fields.every(({ argument }) => stable(target.data[argument]) === stable(args[argument]))
      && stable(untouched(before.entries)) === stable(untouched(after.entries))
      && after.data.user_override_count === before.data.user_override_count + (creation && scope === "user" ? 1 : 0)
      && after.data.group_override_count === before.data.group_override_count + (creation && scope === "group" ? 1 : 0)
      && (creation || beforeProtected === await protectedDigest(target.values, names));
    const verification = { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_readback_mismatch" }) };
    const data = { ...after.data, override_id: target ? Number(target.overrideId) : null };
    return {
      ok: matches, sent: true, status: after.status, data,
      targets: overrideTargets(rechecked, module, after.name, scope, target ? target.data : { module_id: Number(args.module_id) }),
      snapshot_digest: after.snapshot_digest, verification, ...(matches ? {} : { error: "moodle_write_not_verified" }),
    };
  };
  const runFormWrite = async (context, inputValue, definition, args) => {
    const descriptor = formDescriptor(context, definition.kind, args);
    const before = await loadForm(context, descriptor);
    if (!before.ok) return before;
    if (descriptor.type === "label" && !one(before.values, "name").trim()) return error("moodle_label_name_blank");
    if (before.snapshot_digest !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    if (descriptor.type === "forum" && !forumWriteAllowed(before, args)) return error("moodle_forum_native_setting_refused");
    if (descriptor.type === "choice" && args.options !== undefined && before.data.has_responses) return error("moodle_choice_responses_exist");
    if (descriptor.type === "choice" && !choiceWriteAllowed(before, args)) return error("moodle_choice_native_setting_refused");
    if (descriptor.type === "book" && args.numbering !== undefined && !before.data.available_numbering.includes(args.numbering)) return error("moodle_book_native_setting_refused");
    if (descriptor.type === "glossary" && !glossaryWriteAllowed(before, args)) return error("moodle_glossary_native_setting_refused");
    if (descriptor.type === "wiki" && !wikiWriteAllowed(before, args)) return error("moodle_wiki_native_setting_refused");
    if (descriptor.type === "feedback" && !feedbackWriteAllowed(before, args)) return error("moodle_feedback_native_setting_refused");
    if (descriptor.type === "data" && !dataWriteAllowed(before, args)) return error("moodle_database_native_setting_refused");
    if (descriptor.type === "assign") {
      const refusal = assignmentWriteAllowed(before, args);
      if (refusal) return error(refusal);
    }
    if (descriptor.type === "quiz") {
      const refusal = quizWriteAllowed(before, args);
      if (refusal) return error(refusal);
    }
    const names = formChanges(definition.kind, args, before.formData);
    if (!names.length) return error("moodle_arguments_invalid");
    const protectedNames = descriptor.type === "page" ? [...names, "revision"] : names;
    const beforeProtected = await protectedDigest(before.values, protectedNames);
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const posted = await postForm(before);
    if (!posted.ok) return posted;
    const after = await loadForm(rechecked, descriptor);
    if (!after.ok) return { ok: false, sent: true, status: posted.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_readback_unconfirmed" }, error: "moodle_readback_unconfirmed" };
    const revisionMatches = descriptor.type !== "page" || Number(after.values.revision) === Number(before.values.revision) + 1;
    const matches = revisionMatches && expectedFormData(definition.kind, args, after.data, before.data) && beforeProtected === await protectedDigest(after.values, protectedNames);
    const verification = { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_readback_mismatch" }) };
    return { ok: matches, sent: true, status: after.status, data: after.data, targets: formTargets(context, descriptor, after.data), snapshot_digest: after.snapshot_digest, verification, ...(matches ? {} : { error: "moodle_write_not_verified" }) };
  };
  const loadCreationForm = async (context, args, kind) => {
    const selected = await selectedSection(context, args.course_id, args.section_id);
    if (!selected.ok) return selected;
    const descriptor = formDescriptor(context, kind, {
      ...args,
      section_number: sectionNumber(selected.section.number),
      section_name: sectionTarget(selected.section).name,
    });
    const form = await loadForm(context, descriptor);
    return form.ok ? { ...form, section: selected.section } : form;
  };
  const createdModuleId = (context, module, redirectUrl) => {
    try {
      const redirect = new URL(redirectUrl);
      const expected = new URL(urlFor(context, `/mod/${module}/view.php`));
      return redirect.origin === expected.origin && redirect.pathname === expected.pathname ? id(redirect.searchParams.get("id")) : "";
    } catch {
      return "";
    }
  };
  const newCreatedModuleId = (before, after, module, name, sectionId) => {
    if (!before?.ok || !after?.ok) return "";
    const priorIds = new Set(before.data.cm.map((entry) => id(entry?.id)).filter(Boolean));
    const matches = after.data.cm.filter((entry) => !priorIds.has(id(entry?.id))
      && entry?.module === module && entry?.name === name && id(entry?.sectionid) === sectionId && entry?.visible === false && id(entry?.id));
    return matches.length === 1 ? id(matches[0].id) : "";
  };
  const creationDefaultsMatch = (beforeValues, afterValues, names) => {
    const ignored = new Set([...names, "coursecontentnotification", "add", "update", "coursemodule", "instance", "revision", "return", "sr", "beforemod", "showonly", "option_repeats", "option_add_fields"]);
    const emptyFeedback = (values) => Object.hasOwn(values, "feedbacktext[0][text]")
      && Object.entries(values).filter(([name]) => /^feedbacktext\[\d+\]\[text\]$|^feedbackboundaries\[\d+\]$/.test(name)).every(([, value]) => value === "");
    const emptyQuizFeedback = one(beforeValues, "modulename") === "quiz"
      && ["0", "1"].includes(one(beforeValues, "boundary_repeats")) && ["0", "1"].includes(one(afterValues, "boundary_repeats"))
      && emptyFeedback(beforeValues) && emptyFeedback(afterValues);
    return Object.entries(beforeValues).every(([name, value]) => {
      // Moodle saves an empty new passing grade as zero, then formats it for the edit form.
      if (name === "gradepass" && value === "" && typeof afterValues[name] === "string" && /^0(?:[.,]0+)?$/.test(afterValues[name])) return true;
      // Empty Quiz feedback placeholders can collapse to one row on the first save.
      if (emptyQuizFeedback && /^(?:boundary_repeats|feedbacktext\[\d+\]\[(?:text|format)\]|feedbackboundaries\[\d+\])$/.test(name)) return true;
      return ignored.has(name) || /^optionid\[\d+\]$/.test(name) || (Object.hasOwn(afterValues, name) && stable(value) === stable(afterValues[name]));
    });
  };
  const unconfirmedCreate = (status, reason) => ({ ok: false, sent: true, status, outcomeUnknown: true, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason }, error: reason });
  const creationModuleMatches = (module, args, data) => {
    if (module === "forum") return data.forum_type === args.forum_type && data.subscription_mode === args.subscription_mode
      && data.tracking_type === args.tracking_type && stable(data.assessment) === stable(args.assessment)
      && stable(data.due_date) === stable(args.due_date) && stable(data.cutoff_at) === stable(args.cutoff_at);
    if (module === "choice") return data.display === args.display && data.allow_update === args.allow_update && data.allow_multiple === args.allow_multiple
      && data.limit_answers === args.limit_answers && data.show_available === args.show_available
      && stable(data.options) === stable(args.options) && stable(data.limits) === stable(args.limits)
      && stable(data.open_at) === stable(args.open_at) && stable(data.close_at) === stable(args.close_at)
      && data.show_preview === args.show_preview && data.show_results === args.show_results && data.publish_names === args.publish_names
      && data.show_unanswered === args.show_unanswered && data.include_inactive === args.include_inactive;
    if (module === "book") return data.numbering === args.numbering && data.custom_titles === args.custom_titles;
    if (module === "lesson") return stable(data.available_from) === stable(args.available_from) && stable(data.deadline) === stable(args.deadline)
      && data.media_file_state === "empty";
    return true;
  };
  const runCreation = async (context, inputValue, definition, args) => {
    const module = creationModule(definition.kind);
    const spec = creationSpec[module];
    const before = await loadCreationForm(context, args, definition.kind);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    if (spec.requiresSebOff && one(before.values, "seb_requiresafeexambrowser") !== "0") return error("moodle_quiz_seb_create_refused");
    if (spec.module === "forum" && !forumWriteAllowed(before, args)) return error("moodle_forum_native_setting_refused");
    if (spec.module === "choice" && !choiceWriteAllowed(before, args)) return error("moodle_choice_native_setting_refused");
    if (spec.module === "book" && !before.data.available_numbering.includes(args.numbering)) return error("moodle_book_native_setting_refused");
    if (spec.module === "glossary" && !glossaryWriteAllowed(before, args)) return error("moodle_glossary_native_setting_refused");
    if (spec.module === "wiki" && !wikiWriteAllowed(before, args, true)) return error("moodle_wiki_native_setting_refused");
    if (spec.module === "feedback" && !feedbackWriteAllowed(before, args)) return error("moodle_feedback_native_setting_refused");
    if (spec.module === "data" && !dataWriteAllowed(before, args)) return error("moodle_database_native_setting_refused");
    const names = formChanges(definition.kind, args, before.formData);
    if (!names.length) return error("moodle_arguments_invalid");
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const currentSection = await selectedSection(rechecked, args.course_id, args.section_id);
    if (!currentSection.ok || sectionNumber(currentSection.section.number) !== before.descriptor.sectionNumber) return error("moodle_section_target_invalid");
    const beforeState = spec.stateResolved ? await state(rechecked, args.course_id) : null;
    if (spec.stateResolved && !beforeState?.ok) return error("moodle_state_invalid", { status: beforeState?.status });
    const posted = await postForm(before);
    if (!posted.ok) return posted;
    let moduleId = createdModuleId(rechecked, spec.module, posted.redirectUrl);
    let afterState = null;
    if (!moduleId && spec.stateResolved) {
      afterState = await state(rechecked, args.course_id);
      if (!afterState.ok) return unconfirmedCreate(posted.status, "moodle_readback_unconfirmed");
      moduleId = newCreatedModuleId(beforeState, afterState, spec.module, args.name, args.section_id);
    }
    if (!moduleId) return unconfirmedCreate(posted.status, `moodle_${spec.module}_create_redirect_unconfirmed`);
    const readKind = spec.readKind || (spec.module === "page" ? "page-form-read" : spec.module === "assign" ? "assignment-form-read" : "quiz-form-read");
    const after = await loadForm(rechecked, formDescriptor(rechecked, readKind, { course_id: args.course_id, module_id: moduleId }));
    if (!after.ok) return unconfirmedCreate(posted.status, "moodle_readback_unconfirmed");
    afterState ||= await state(rechecked, args.course_id);
    if (!afterState.ok) return unconfirmedCreate(posted.status, "moodle_readback_unconfirmed");
    const activity = afterState.data.cm.find((entry) => id(entry?.id) === moduleId);
    const data = { ...after.data, section_id: Number(args.section_id), visible: one(after.values, "visible") === "1" };
    const matches = data.name === args.name && data[spec.dataBody] === args[spec.dataBody] && (spec.fields || []).every(({ argument, kind }) => data[argument] === (kind === "url" || spec.module === "url" ? nativeUrlValue(args[argument]) : args[argument])) && spec.dates.every(({ argument }) => stable(data[argument]) === stable(args[argument])) && creationModuleMatches(spec.module, args, data) && data.visible === false
      && one(after.values, "section") === one(before.values, "section")
      && creationDefaultsMatch(before.values, after.values, names)
      && isObject(activity) && activity.module === spec.module && id(activity.sectionid) === args.section_id && activity.visible === false;
    const verification = { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_readback_mismatch" }) };
    return { ok: matches, sent: true, status: after.status, data, targets: [courseTarget(rechecked), sectionTarget(before.section)], snapshot_digest: after.snapshot_digest, verification, ...(matches ? {} : { error: "moodle_write_not_verified" }) };
  };
  const stateProtectedDigest = async (stateValue, collection, targetId, sectionChildIds = [], delegated = { sections: [], activities: [] }) => {
    const copy = JSON.parse(JSON.stringify(stateValue));
    const target = Array.isArray(copy[collection]) ? copy[collection].find((entry) => id(entry?.id) === targetId) : null;
    if (target) {
      delete target.visible;
      // Moodle derives these activity fields from the visibility changed by this action.
      if (collection === "cm") for (const name of ["accessvisible", "hascmrestrictions", "stealth"]) delete target[name];
      if (collection === "section") delete target.hasrestrictions;
    }
    if (collection === "section") {
      const childIds = new Set(sectionChildIds);
      for (const child of copy.cm || []) {
        if (childIds.has(id(child?.id))) for (const name of ["visible", "accessvisible", "hascmrestrictions", "allowstealth"]) delete child[name];
      }
    }
    // Moodle carries a subsection's visibility into the section it owns and
    // into every activity that section holds, so those fields are compared as
    // the planned values below instead of as unchanged ones.
    const delegatedSections = new Set(delegated.sections);
    const delegatedActivities = new Set(delegated.activities);
    if (delegatedSections.size) for (const entry of copy.section || []) {
      if (delegatedSections.has(id(entry?.id))) for (const name of ["visible", "hasrestrictions"]) delete entry[name];
    }
    if (delegatedActivities.size) for (const child of copy.cm || []) {
      if (delegatedActivities.has(id(child?.id))) for (const name of ["visible", "accessvisible", "hascmrestrictions", "allowstealth", "stealth"]) delete child[name];
    }
    return digest(contentData(copy));
  };
  const oneEntry = (entries, targetId) => {
    const matches = Array.isArray(entries) ? entries.filter((entry) => id(entry?.id) === targetId) : [];
    return matches.length === 1 ? matches[0] : null;
  };
  const ordinaryVisibleSection = (entry) => Boolean(entry) && (entry.component === null || entry.component === "")
    && entry.visible === true && entry.hasrestrictions === false && sectionNumber(entry.number) !== "";
  const cmlistWithOne = (entry, moduleId) => {
    if (!Array.isArray(entry?.cmlist) || entry.cmlist.some((cmId) => !id(cmId)) || new Set(entry.cmlist.map(id)).size !== entry.cmlist.length) return null;
    const matches = entry.cmlist.filter((cmId) => id(cmId) === moduleId);
    return matches.length === 1 ? matches[0] : null;
  };
  const sectionMembershipMatches = (data, section) => {
    if (!Array.isArray(section?.cmlist) || section.cmlist.some((cmId) => !id(cmId)) || new Set(section.cmlist.map(id)).size !== section.cmlist.length) return false;
    const sectionId = id(section.id);
    const direct = data.cm.filter((entry) => id(entry?.sectionid) === sectionId).map((entry) => id(entry?.id));
    return direct.length === section.cmlist.length && direct.every((cmId) => cmId && section.cmlist.some((listed) => id(listed) === cmId));
  };
  // Moodle's Subsection module owns a course section and shows it inside the
  // section that holds the activity. A change that reaches one of those
  // sections reaches every activity in it, so the pairing is read in full
  // before any such change: every owned section paired with the one activity
  // that delegates it, its parent section, and the activities it holds, in the
  // order the course state gives. A pairing this cannot state exactly, and any
  // other component that owns a section, refuse instead.
  // https://github.com/moodle/moodle/blob/v5.2.2/public/mod/subsection/lib.php
  const DELEGATING_MODULE = "subsection";
  const DELEGATING_COMPONENT = "mod_subsection";
  const delegatedMembership = (data) => {
    const sections = Array.isArray(data?.section) ? data.section : [];
    const activities = Array.isArray(data?.cm) ? data.cm : [];
    const bySection = new Map();
    const byCm = new Map();
    for (const section of sections) {
      const sectionId = id(section?.id);
      if (!sectionId) return null;
      if (section.component === null || section.component === "") continue;
      // The state's own `itemid` never crosses the bridge, so the pairing is
      // read from the section the activity names and the parent it reports.
      if (section.component !== DELEGATING_COMPONENT) return null;
      const owners = activities.filter((entry) => entry?.hasdelegatedsection === true && id(entry?.delegatesectionid) === sectionId);
      if (owners.length !== 1 || owners[0].module !== DELEGATING_MODULE) return null;
      const parentId = id(section.parentsectionid);
      const parents = sections.filter((entry) => id(entry?.id) === parentId);
      // Moodle does not let a subsection hold a subsection, so an owned
      // section whose parent is itself owned cannot be planned forward.
      if (!parentId || parentId !== id(owners[0].sectionid) || parents.length !== 1
        || (parents[0].component !== null && parents[0].component !== "")) return null;
      if (!sectionMembershipMatches(data, section)) return null;
      const record = { section, activity: owners[0], parent: parents[0], children: activities.filter((entry) => id(entry?.sectionid) === sectionId) };
      bySection.set(sectionId, record);
      byCm.set(id(owners[0].id), record);
    }
    for (const entry of activities) {
      if (entry?.hasdelegatedsection === true && !byCm.has(id(entry?.id))) return null;
    }
    return { bySection, byCm };
  };
  const delegatedActivityNames = (children) => children.map((entry) => ({
    module_id: Number(id(entry.id)), name: String(entry.name || id(entry.id)), module: String(entry.module || ""),
  }));
  const canonicalMoveState = (value) => {
    if (!isObject(value) || !Array.isArray(value.cm)) return null;
    const seen = new Set();
    for (const entry of value.cm) {
      const entryId = id(entry?.id);
      if (!entryId || seen.has(entryId)) return null;
      seen.add(entryId);
    }
    const copy = JSON.parse(JSON.stringify(value));
    copy.cm.sort((left, right) => Number(id(left.id)) - Number(id(right.id)));
    return copy;
  };
  // A section this move may take an activity from or put one into: an ordinary
  // visible section, or a visible section Moodle's Subsection module owns whose
  // complete membership has just been read.
  const moveEndpointSection = (entry, membership) => ordinaryVisibleSection(entry)
    || (Boolean(entry) && entry.visible === true && entry.hasrestrictions === false
      && sectionNumber(entry.number) !== "" && membership.bySection.has(id(entry.id)));
  const moveContract = (data, moduleId, targetSectionId) => {
    const membership = delegatedMembership(data);
    if (!membership) return null;
    const activity = oneEntry(data.cm, moduleId);
    const source = activity ? oneEntry(data.section, id(activity.sectionid)) : null;
    const destination = oneEntry(data.section, targetSectionId);
    const movedMember = cmlistWithOne(source, moduleId);
    const delegated = membership.byCm.get(moduleId) || null;
    if (!activity || !source || !destination || id(source.id) === targetSectionId
      || !moveEndpointSection(source, membership) || !moveEndpointSection(destination, membership)
      || !["page", "assign", "quiz", "label", "url", DELEGATING_MODULE].includes(activity.module)
      // The subsection module is the one module here that owns a section, and
      // Moodle refuses a subsection moved into a subsection.
      || activity.hasdelegatedsection !== (activity.module === DELEGATING_MODULE) || Boolean(delegated) !== (activity.module === DELEGATING_MODULE)
      || (delegated && membership.bySection.has(targetSectionId))
      || activity.visible !== true || activity.stealth !== false
      || activity.uservisible !== true || activity.accessvisible !== true || activity.hascmrestrictions !== false
      || movedMember === null || !sectionMembershipMatches(data, source) || !sectionMembershipMatches(data, destination) || destination.cmlist.some((cmId) => id(cmId) === moduleId)) return null;
    return { activity, source, destination, movedMember, delegated, destinationDelegated: membership.bySection.get(targetSectionId) || null };
  };
  const expectedMoveState = (data, moduleId, targetSectionId) => {
    const contract = moveContract(data, moduleId, targetSectionId);
    if (!contract) return null;
    const copy = JSON.parse(JSON.stringify(data));
    const activity = oneEntry(copy.cm, moduleId);
    const source = oneEntry(copy.section, id(contract.source.id));
    const destination = oneEntry(copy.section, targetSectionId);
    if (!activity || !source || !destination) return null;
    activity.sectionid = contract.destination.id;
    activity.sectionnumber = contract.destination.number;
    source.cmlist = source.cmlist.filter((cmId) => id(cmId) !== moduleId);
    destination.cmlist = [...destination.cmlist, contract.movedMember];
    if (contract.delegated) {
      // Moodle shows an owned section inside the section that holds the
      // activity delegating it, so moving that activity moves the section it
      // owns, with everything in it.
      const owned = oneEntry(copy.section, id(contract.delegated.section.id));
      if (!owned) return null;
      owned.parentsectionid = contract.destination.id;
    }
    return canonicalMoveState(copy);
  };
  const moveCourseFormat = async (context, courseId) => {
    const descriptor = formDescriptor(context, "course-form-read", { course_id: courseId });
    const form = await loadForm(context, { ...descriptor, strictIdentity: true, finalRoute: { id: courseId } });
    return form.ok ? one(form.values, "format") || null : null;
  };
  const runMoveActivity = async (context, inputValue, args) => {
    const format = await moveCourseFormat(context, args.course_id);
    if (!["topics", "weeks"].includes(format)) return error("moodle_move_course_format_unverified");
    const before = await state(context, args.course_id);
    if (!before.ok) return before;
    const beforeData = contentData(before.data);
    if (await digest(beforeData) !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    // A course whose subsection pairing cannot be read in full is refused
    // before anything is sent, because a move that reaches an owned section
    // cannot name what it carries.
    if (!delegatedMembership(before.data)) return error("moodle_delegated_membership_incomplete");
    const contract = moveContract(before.data, args.module_id, args.target_section_id);
    const expected = expectedMoveState(before.data, args.module_id, args.target_section_id);
    if (!contract || !expected) return error("moodle_move_precondition_refused");
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    if (await moveCourseFormat(rechecked, args.course_id) !== format) return error("moodle_move_course_format_changed");
    if (!sameContext(rechecked, currentContext())) return error("moodle_binding_mismatch");
    const update = await ajax(rechecked, "core_courseformat_update_course", {
      action: "cm_move", courseid: Number(args.course_id), ids: [Number(args.module_id)], targetsectionid: Number(args.target_section_id), targetcmid: null,
    }, true);
    if (!update.ok) return update;
    const after = await state(rechecked, args.course_id);
    if (!after.ok) return { ok: false, sent: true, status: update.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_readback_unconfirmed" }, error: "moodle_readback_unconfirmed" };
    const actual = canonicalMoveState(after.data);
    const afterFormat = await moveCourseFormat(rechecked, args.course_id);
    if (!afterFormat) return { ok: false, sent: true, status: update.status, outcomeUnknown: true, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_readback_unconfirmed" }, error: "moodle_readback_unconfirmed" };
    const matches = Boolean(actual) && stable(expected) === stable(actual) && afterFormat === format;
    const data = contentData(after.data);
    return {
      ok: matches,
      sent: true,
      status: after.status,
      data,
      targets: [
        courseTarget(rechecked, after.data.course.fullname || after.data.course.name),
        { field: "module_id", label: "Activity", name: String(contract.activity.name || args.module_id) },
        { field: "target_section_id", label: "Destination section", name: String(contract.destination.title || contract.destination.rawtitle || args.target_section_id) },
      ],
      snapshot_digest: await digest(data),
      ...(contract.delegated || contract.destinationDelegated ? {
        delegated: {
          // Every activity this move carries with the moved one, and the
          // subsection it is placed inside when the destination is one.
          subsection_moved: contract.delegated ? String(contract.delegated.activity.name || args.module_id) : null,
          destination_subsection: contract.destinationDelegated ? String(contract.destinationDelegated.activity.name || args.target_section_id) : null,
          affected_activities: delegatedActivityNames(contract.delegated ? contract.delegated.children : []),
        },
      } : {}),
      verification: { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_readback_mismatch" }) },
      ...(matches ? {} : { error: "moodle_write_not_verified" }),
    };
  };
  /**
   * What a visibility change does to the sections Moodle's Subsection module
   * owns, read from the complete pairing.
   *
   * Moodle carries a subsection activity's visibility into the section it owns
   * and, from there, into every activity that section holds
   * (`cmactions::set_visibility` -> `update_delegated` ->
   * `sectionactions::update` -> `transfer_visibility_to_cms`). A hide sets each
   * of those activities hidden whatever it was. A show puts each one back to
   * the visibility Moodle stored before, and the course state does not carry
   * that stored value, so a show that would restore one is refused.
   * https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/local/sectionactions.php#L589-L634
   */
  const delegatedVisibilityPlan = (data, membership, collection, targetId, expectedVisible) => {
    const records = [];
    if (collection === "cm") {
      const owned = membership.byCm.get(targetId);
      if (owned) records.push({ ...owned, delegatorAffected: false });
    } else {
      // Hiding the section itself also hides the activity that delegates it.
      const owned = membership.bySection.get(targetId);
      if (owned) records.push({ ...owned, delegatorAffected: true });
      for (const child of data.cm) {
        if (id(child?.sectionid) !== targetId) continue;
        const held = membership.byCm.get(id(child?.id));
        if (held) records.push({ ...held, delegatorAffected: false });
      }
    }
    if (!records.length) return { records: [], sections: [], activities: [] };
    // Moodle keeps a subsection activity and the section it owns at the same
    // visibility. A pair that already differs cannot be planned forward.
    if (records.some((record) => record.activity.visible !== record.section.visible)) return { error: "moodle_delegated_visibility_partial" };
    // The only show this can state exactly is one that restores nothing: the
    // subsection activity itself, holding no activity.
    if (expectedVisible && records.some((record) => collection !== "cm" || record.children.length > 0)) return { error: "moodle_delegated_show_refused" };
    // Changing the owned section directly, when it already has the requested
    // visibility, leaves the subtree untouched and its activities as they are.
    if (collection === "section" && records[0].delegatorAffected && records[0].section.visible === expectedVisible) return { error: "moodle_delegated_visibility_unchanged" };
    const changing = records.filter((record) => record.section.visible !== expectedVisible);
    return {
      records,
      sections: changing.map((record) => id(record.section.id)),
      activities: changing.flatMap((record) => [
        ...(record.delegatorAffected ? [id(record.activity.id)] : []),
        ...record.children.map((child) => id(child.id)),
      ]),
    };
  };
  const delegatedVisibilityMatches = (afterData, plan, expectedVisible) => {
    if (!plan.records.length) return true;
    for (const sectionId of plan.sections) {
      const entry = afterData.section.find((value) => id(value?.id) === sectionId);
      if (!entry || entry.visible !== expectedVisible || typeof entry.hasrestrictions !== "boolean") return false;
      if (!expectedVisible && entry.hasrestrictions !== false) return false;
    }
    for (const activityId of plan.activities) {
      const entry = afterData.cm.find((value) => id(value?.id) === activityId);
      if (!entry || entry.visible !== false || entry.accessvisible !== false || entry.hascmrestrictions !== false
        || entry.stealth !== false || typeof entry.allowstealth !== "boolean") return false;
    }
    // The pairing must still read in full after the change.
    return Boolean(delegatedMembership(afterData));
  };
  const runVisibility = async (context, inputValue, definition, args) => {
    if (definition.kind === "course-show" || definition.kind === "course-hide") return runFormWrite(context, inputValue, definition, args);
    const collection = definition.kind.startsWith("section") ? "section" : "cm";
    const targetId = collection === "section" ? args.section_id : args.module_id;
    const before = await state(context, args.course_id);
    if (!before.ok) return before;
    const beforeData = contentData(before.data);
    const beforeDigest = await digest(beforeData);
    if (beforeDigest !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    const target = before.data[collection].find((entry) => id(entry?.id) === targetId);
    if (!target) return error("moodle_target_mismatch");
    const expectedVisible = definition.kind.endsWith("show");
    // A course whose subsection pairing cannot be read in full is refused
    // before anything is sent.
    const membership = delegatedMembership(before.data);
    if (!membership) return error("moodle_delegated_membership_incomplete");
    const plan = delegatedVisibilityPlan(before.data, membership, collection, targetId, expectedVisible);
    if (plan.error) return error(plan.error);
    const sectionChildren = collection === "section" ? before.data.cm.filter((entry) => id(entry?.sectionid) === targetId) : [];
    const sectionChildIds = sectionChildren.map((entry) => id(entry?.id));
    const protectedBefore = await stateProtectedDigest(before.data, collection, targetId, sectionChildIds, plan);
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const action = definition.kind.endsWith("show") ? `${collection === "section" ? "section" : "cm"}_show` : `${collection === "section" ? "section" : "cm"}_hide`;
    const update = await ajax(rechecked, "core_courseformat_update_course", { action, courseid: Number(args.course_id), ids: [Number(targetId)], targetsectionid: null, targetcmid: null }, true);
    if (!update.ok) return update;
    const after = await state(context, args.course_id);
    if (!after.ok) return { ok: false, sent: true, status: update.status, verification: { schema: "morrow.browser-verification.v1", status: "unconfirmed", reason: "moodle_readback_unconfirmed" }, error: "moodle_readback_unconfirmed" };
    const afterTarget = after.data[collection].find((entry) => id(entry?.id) === targetId);
    const section = collection === "cm" ? after.data.section.find((entry) => id(entry?.id) === id(afterTarget?.sectionid)) : null;
    const afterSectionChildren = collection === "section" ? after.data.cm.filter((entry) => id(entry?.sectionid) === targetId) : [];
    const sectionChildrenMatch = collection !== "section" || (sectionChildren.length === afterSectionChildren.length
      && sectionChildren.every((entry) => afterSectionChildren.some((afterEntry) => id(afterEntry?.id) === id(entry?.id)))
      && afterSectionChildren.every((entry) => typeof entry?.visible === "boolean" && typeof entry?.accessvisible === "boolean"
        && typeof entry?.hascmrestrictions === "boolean" && typeof entry?.allowstealth === "boolean" && typeof entry?.stealth === "boolean"
        && (expectedVisible || entry.visible === false)
        && (entry.visible || (!entry.accessvisible && !entry.hascmrestrictions))));
    const derivedMatches = collection !== "cm" || (Boolean(section)
      && typeof afterTarget?.accessvisible === "boolean" && typeof afterTarget?.hascmrestrictions === "boolean"
      && afterTarget?.stealth === (expectedVisible && section.visible === false)
      && (expectedVisible || (afterTarget?.accessvisible === false && afterTarget?.hascmrestrictions === false)));
    const sectionMatches = collection !== "section" || (typeof afterTarget?.hasrestrictions === "boolean" && (expectedVisible || afterTarget.hasrestrictions === false));
    const matches = Boolean(afterTarget) && afterTarget.visible === expectedVisible && derivedMatches && sectionMatches && sectionChildrenMatch
      && delegatedVisibilityMatches(after.data, plan, expectedVisible)
      && protectedBefore === await stateProtectedDigest(after.data, collection, targetId, sectionChildIds, plan);
    const data = contentData(after.data);
    return {
      ok: matches,
      sent: true,
      status: after.status,
      data,
      targets: [courseTarget(rechecked, after.data.course.fullname || after.data.course.name), { field: collection === "section" ? "section_id" : "module_id", label: collection === "section" ? "Section" : "Activity", name: targetId }],
      snapshot_digest: await digest(data),
      ...(plan.records.length ? {
        delegated: {
          // Every subsection this change reaches, with every activity it holds.
          subsections: plan.records.map((record) => ({
            section_id: Number(id(record.section.id)),
            module_id: Number(id(record.activity.id)),
            name: String(record.activity.name || id(record.activity.id)),
            visibility_changed: plan.sections.includes(id(record.section.id)),
            activities: delegatedActivityNames(record.children),
          })),
        },
      } : {}),
      verification: { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_readback_mismatch" }) },
      ...(matches ? {} : { error: "moodle_write_not_verified" }),
    };
  };
  const bookTargets = (context, book, chapter = null) => [
    courseTarget(context, book.course.fullname || book.course.name),
    { field: "module_id", label: "Book", name: String(book.name || book.book?.id || "Book") },
    ...(chapter ? [{ field: "chapter_id", label: "Chapter", name: String(chapter.title || chapter.chapter_id || "Chapter") }] : []),
  ];
  const bookChapterDescriptor = (context, args, book, options = {}) => {
    const params = { cmid: args.module_id, ...(options.chapter_id ? { id: options.chapter_id } : { pagenum: options.after_pagenum || 0, subchapter: options.subchapter ? 1 : 0 }) };
    return {
      type: "book-chapter", expectedPath: "/mod/book/edit.php", endpoint: urlFor(context, "/mod/book/edit.php", params),
      expected: options.chapter_id ? { cmid: args.module_id, id: options.chapter_id } : { cmid: args.module_id },
      required: ["cmid", "id", "title", "content_editor[text]", "pagenum"], courseId: args.course_id, moduleId: args.module_id,
      ...(options.chapter_id ? { chapterId: options.chapter_id } : {}), bookName: book.name, strictIdentity: true,
    };
  };
  const bookChapterDataValid = (data, chapterId = "", allowNew = false) => Boolean(data) && (allowNew ? !id(data.chapter_id) : id(data.chapter_id) && (!chapterId || id(data.chapter_id) === chapterId))
    && validString(data.title, 1333) && (allowNew || Boolean(data.title)) && validString(data.content, 40000)
    && Number.isSafeInteger(data.pagenum) && data.pagenum >= 1 && typeof data.subchapter === "boolean"
    && ["empty", "nonempty", "unverified"].includes(data.content_file_state);
  const loadBookChapter = async (context, args, book, chapterId) => {
    const form = await loadForm(context, bookChapterDescriptor(context, args, book, { chapter_id: chapterId }));
    if (!form.ok) return form;
    if (!bookChapterDataValid(form.data, chapterId)) return error("moodle_book_chapter_target_invalid", { status: form.status });
    return form;
  };
  const loadBookTocChapterIds = async (context, args) => {
    const endpoint = urlFor(context, "/mod/book/edit.php", { cmid: args.module_id, pagenum: 0 });
    let response;
    try { response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", headers: { Accept: "text/html" } }); } catch { return error("moodle_book_chapters_unavailable"); }
    let text;
    try { text = await readText(response); } catch { return { ...error("moodle_book_chapters_unavailable"), status: response.status }; }
    if (!sameContext(context, currentContext()) || !response.ok || typeof DOMParser === "undefined") return { ...error("moodle_book_chapters_unavailable"), status: response.status };
    let finalUrl;
    let documentValue;
    try { finalUrl = new URL(response.url || endpoint); documentValue = new DOMParser().parseFromString(text, "text/html"); } catch { return { ...error("moodle_book_chapters_unavailable"), status: response.status }; }
    const expected = new URL(endpoint);
    if (finalUrl.origin !== expected.origin || finalUrl.pathname !== expected.pathname) return { ...error("moodle_book_chapters_unavailable"), status: response.status };
    const chapters = [];
    const seen = new Set();
    for (const anchor of documentValue.querySelectorAll("a[href]")) {
      let href;
      try { href = new URL(anchor.getAttribute("href"), endpoint); } catch { continue; }
      if (href.origin !== expected.origin) continue;
      let chapterId = "";
      if (href.pathname === urlFor(context, "/mod/book/edit.php").replace(/^https?:\/\/[^/]+/, "")) {
        if (href.searchParams.get("cmid") !== args.module_id) continue;
        chapterId = id(href.searchParams.get("id"));
      } else if (href.pathname === urlFor(context, "/mod/book/view.php").replace(/^https?:\/\/[^/]+/, "")) {
        if (href.searchParams.get("id") !== args.module_id) continue;
        chapterId = id(href.searchParams.get("chapterid"));
      }
      if (!chapterId || seen.has(chapterId)) continue;
      seen.add(chapterId);
      chapters.push({ id: chapterId, hidden: null });
      if (chapters.length > MAX_ITEMS) return error("moodle_book_chapter_limit_exceeded", { status: response.status });
    }
    for (const anchor of documentValue.querySelectorAll("a[href]")) {
      let href;
      try { href = new URL(anchor.getAttribute("href"), endpoint); } catch { continue; }
      if (href.origin !== expected.origin || href.pathname !== urlFor(context, "/mod/book/show.php").replace(/^https?:\/\/[^/]+/, "")) continue;
      if (href.searchParams.get("id") !== args.module_id) continue;
      const chapter = chapters.find((entry) => entry.id === id(href.searchParams.get("chapterid")));
      if (!chapter || chapter.hidden !== null) return error("moodle_book_chapter_visibility_unavailable", { status: response.status });
      let icon;
      try { icon = new URL(anchor.querySelector("img")?.getAttribute("src") || "", endpoint); } catch { return error("moodle_book_chapter_visibility_unavailable", { status: response.status }); }
      if (/\/t\/hide(?:\.[a-z]+)?$/i.test(icon.pathname)) chapter.hidden = false;
      else if (/\/t\/show(?:\.[a-z]+)?$/i.test(icon.pathname)) chapter.hidden = true;
      else return error("moodle_book_chapter_visibility_unavailable", { status: response.status });
    }
    if (chapters.some((chapter) => typeof chapter.hidden !== "boolean")) return error("moodle_book_chapter_visibility_unavailable", { status: response.status });
    return { ok: true, sent: true, status: response.status, chapters };
  };
  const normaliseBookChapters = (chapters) => {
    if (!Array.isArray(chapters) || chapters.length > MAX_ITEMS) return null;
    const seen = new Set();
    let parent = "";
    const normalized = [];
    for (const [index, chapter] of chapters.entries()) {
      const chapterId = id(chapter?.chapter_id);
      if (!chapterId || seen.has(chapterId) || !validString(chapter?.title, 1333) || !chapter.title || typeof chapter.subchapter !== "boolean") return null;
      seen.add(chapterId);
      if (!chapter.subchapter) parent = chapterId;
      else if (!parent) return null;
      if (typeof chapter.hidden !== "boolean") return null;
      normalized.push({ chapter_id: Number(chapterId), title: chapter.title, pagenum: index + 1, subchapter: chapter.subchapter, hidden: chapter.hidden, ...(chapter.subchapter ? { parent_chapter_id: Number(parent) } : {}), content_file_state: chapter.content_file_state });
    }
    return normalized;
  };
  const bookStructureDigest = (args, chapters) => digest({ course_id: Number(args.course_id), module_id: Number(args.module_id), chapters: chapters.map(({ chapter_id, title, pagenum, subchapter, hidden, parent_chapter_id, content_file_state }) => ({ chapter_id, title, pagenum, subchapter, hidden, content_file_state, ...(parent_chapter_id ? { parent_chapter_id } : {}) })) });
  const listBookChapters = async (context, args) => {
    const book = await bookBinding(context, args);
    if (!book.ok) return book;
    const toc = await loadBookTocChapterIds(context, args);
    if (!toc.ok) return toc;
    const chapters = [];
    for (const tocChapter of toc.chapters) {
      const form = await loadBookChapter(context, args, book, tocChapter.id);
      if (!form.ok) return form;
      chapters.push({ ...form.data, hidden: tocChapter.hidden });
    }
    const ordered = [...chapters].sort((left, right) => left.pagenum - right.pagenum);
    if (ordered.some((chapter, index) => chapter.pagenum !== index + 1)) return error("moodle_book_chapter_structure_invalid");
    const normalized = normaliseBookChapters(ordered);
    if (!normalized) return error("moodle_book_chapter_structure_invalid");
    const data = { course_id: Number(args.course_id), module_id: Number(args.module_id), chapters: normalized };
    return { ok: true, sent: true, status: toc.status, data, targets: bookTargets(context, book), snapshot_digest: await bookStructureDigest(args, normalized), book };
  };
  const loadBookChapterCreationForm = async (context, args) => {
    const listed = await listBookChapters(context, args);
    if (!listed.ok) return listed;
    const requestedAfter = args.after_chapter_id || "";
    const after = requestedAfter ? listed.data.chapters.find((chapter) => id(chapter.chapter_id) === requestedAfter) : listed.data.chapters.at(-1);
    if (requestedAfter && !after) return error("moodle_book_after_chapter_invalid");
    const subchapter = args.subchapter === undefined ? false : args.subchapter;
    if (!listed.data.chapters.length && subchapter) return error("moodle_book_first_chapter_subchapter");
    const form = await loadForm(context, bookChapterDescriptor(context, args, listed.book, { after_pagenum: after?.pagenum || 0, subchapter }));
    if (!form.ok) return form;
    if (!bookChapterDataValid(form.data, "", true)) return error("moodle_book_chapter_target_invalid", { status: form.status });
    if (form.data.pagenum !== (after?.pagenum || 0) + 1 || form.data.subchapter !== subchapter) return error("moodle_book_chapter_target_invalid", { status: form.status });
    const snapshot_digest = await digest({ form: form.values, structure: listed.data.chapters, after_chapter_id: after ? id(after.chapter_id) : null, subchapter });
    const result = { ...form, listed, after_chapter_id: after ? id(after.chapter_id) : "", subchapter, snapshot_digest };
    result.revalidate = (current) => loadBookChapterCreationForm(current, args);
    return result;
  };
  const createdBookChapterId = (context, moduleId, redirectUrl) => {
    try {
      const redirect = new URL(redirectUrl);
      const expected = new URL(urlFor(context, "/mod/book/view.php"));
      return redirect.origin === expected.origin && redirect.pathname === expected.pathname && redirect.searchParams.get("id") === moduleId ? id(redirect.searchParams.get("chapterid")) : "";
    } catch { return ""; }
  };
  const bookChapterChanges = (args, formData) => {
    const names = [];
    if (args.title !== undefined) { setField(formData, "title", args.title); names.push("title"); }
    if (args.content !== undefined) { setField(formData, "content_editor[text]", args.content); names.push("content_editor[text]"); }
    if (args.subchapter !== undefined) { setField(formData, "subchapter", args.subchapter ? 1 : 0); names.push("subchapter"); }
    return names;
  };
  const runBookChapterCreation = async (context, inputValue, args) => {
    const before = await loadBookChapterCreationForm(context, args);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    const names = bookChapterChanges(args, before.formData);
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const posted = await postForm(before);
    if (!posted.ok) return posted;
    const chapterId = createdBookChapterId(rechecked, args.module_id, posted.redirectUrl);
    if (!chapterId) return unconfirmedCreate(posted.status, "moodle_book_chapter_create_redirect_unconfirmed");
    const after = await listBookChapters(rechecked, args);
    if (!after.ok) return unconfirmedCreate(posted.status, "moodle_readback_unconfirmed");
    const beforeIds = before.listed.data.chapters.map((chapter) => id(chapter.chapter_id));
    const afterIds = after.data.chapters.map((chapter) => id(chapter.chapter_id));
    const position = before.after_chapter_id ? beforeIds.indexOf(before.after_chapter_id) + 1 : beforeIds.length;
    const created = after.data.chapters.find((chapter) => id(chapter.chapter_id) === chapterId);
    const matches = Boolean(created) && created.title === args.title && created.subchapter === args.subchapter && created.pagenum === position + 1
      && afterIds.length === beforeIds.length + 1 && afterIds[position] === chapterId
      && stable(afterIds.filter((entry) => entry !== chapterId)) === stable(beforeIds);
    const verification = { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_readback_mismatch" }) };
    return { ok: matches, sent: true, status: after.status, data: created || null, targets: bookTargets(rechecked, after.book, created), snapshot_digest: after.snapshot_digest, verification, ...(matches ? {} : { error: "moodle_write_not_verified" }) };
  };
  const runBookChapterUpdate = async (context, inputValue, args) => {
    const book = await bookBinding(context, args);
    if (!book.ok) return book;
    const before = await loadBookChapter(context, args, book, args.chapter_id);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    const names = bookChapterChanges(args, before.formData);
    if (!names.length) return error("moodle_arguments_invalid");
    const protectedBefore = await protectedDigest(before.values, names);
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const posted = await postForm(before);
    if (!posted.ok) return posted;
    const afterBook = await bookBinding(rechecked, args);
    if (!afterBook.ok) return unconfirmedCreate(posted.status, "moodle_readback_unconfirmed");
    const after = await loadBookChapter(rechecked, args, afterBook, args.chapter_id);
    if (!after.ok) return unconfirmedCreate(posted.status, "moodle_readback_unconfirmed");
    const matches = (args.title === undefined || after.data.title === args.title) && (args.content === undefined || after.data.content === args.content)
      && protectedBefore === await protectedDigest(after.values, names);
    const verification = { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_readback_mismatch" }) };
    return { ok: matches, sent: true, status: after.status, data: after.data, targets: bookTargets(rechecked, afterBook, after.data), snapshot_digest: after.snapshot_digest, verification, ...(matches ? {} : { error: "moodle_write_not_verified" }) };
  };
  const bookMovePlan = (chapters, chapterId, direction) => {
    const targetIndex = chapters.findIndex((chapter) => id(chapter.chapter_id) === chapterId);
    if (targetIndex < 0) return null;
    const target = chapters[targetIndex];
    const copy = chapters.map((chapter) => ({ ...chapter }));
    if (target.subchapter) {
      const siblingIndex = targetIndex + (direction === "up" ? -1 : 1);
      if (siblingIndex < 0 || siblingIndex >= copy.length || !copy[siblingIndex].subchapter || copy[siblingIndex].parent_chapter_id !== target.parent_chapter_id) return null;
      [copy[targetIndex], copy[siblingIndex]] = [copy[siblingIndex], copy[targetIndex]];
      return normaliseBookChapters(copy);
    }
    const groups = [];
    for (const chapter of copy) {
      if (!chapter.subchapter) groups.push([chapter]);
      else if (!groups.length) return null;
      else groups.at(-1).push(chapter);
    }
    const groupIndex = groups.findIndex((group) => id(group[0].chapter_id) === chapterId);
    const next = groupIndex + (direction === "up" ? -1 : 1);
    if (groupIndex < 0 || next < 0 || next >= groups.length) return null;
    [groups[groupIndex], groups[next]] = [groups[next], groups[groupIndex]];
    return normaliseBookChapters(groups.flat());
  };
  const runBookChapterMove = async (context, inputValue, args) => {
    const before = await listBookChapters(context, args);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    const expected = bookMovePlan(before.data.chapters, args.chapter_id, args.direction);
    if (!expected) return error("moodle_book_chapter_move_unavailable");
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const endpoint = urlFor(rechecked, "/mod/book/move.php", { id: args.module_id, chapterid: args.chapter_id, up: args.direction === "up" ? 1 : 0, sesskey: rechecked.sesskey });
    let response;
    try { response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "manual", headers: { Accept: "text/html" } }); } catch { return unconfirmedCreate(undefined, "moodle_book_chapter_move_response_unknown"); }
    // Fetch exposes a manual same-origin redirect as an opaque redirect. The fixed native endpoint and the authoritative chapter-list readback bind that response without following an activity view.
    if (response.type !== "opaqueredirect") {
      let redirect;
      try { redirect = new URL(response.headers.get("location") || "", endpoint); } catch { return unconfirmedCreate(response.status, "moodle_book_chapter_move_redirect_unconfirmed"); }
      const expectedRedirect = new URL(urlFor(rechecked, "/mod/book/view.php"));
      if (![301, 302, 303, 307, 308].includes(response.status) || redirect.origin !== expectedRedirect.origin || redirect.pathname !== expectedRedirect.pathname
        || redirect.searchParams.get("id") !== args.module_id || redirect.searchParams.get("chapterid") !== args.chapter_id) return unconfirmedCreate(response.status, "moodle_book_chapter_move_redirect_unconfirmed");
    }
    const after = await listBookChapters(rechecked, args);
    if (!after.ok) return unconfirmedCreate(response.status, "moodle_readback_unconfirmed");
    const matches = stable(after.data.chapters) === stable(expected);
    const moved = after.data.chapters.find((chapter) => id(chapter.chapter_id) === args.chapter_id);
    const verification = { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_readback_mismatch" }) };
    return { ok: matches, sent: true, status: after.status, data: after.data, targets: bookTargets(rechecked, after.book, moved), snapshot_digest: after.snapshot_digest, verification, ...(matches ? {} : { error: "moodle_write_not_verified" }) };
  };
  const bookChapterVisibilityPlan = (chapters, chapterId, hidden) => {
    const index = chapters.findIndex((chapter) => id(chapter.chapter_id) === chapterId);
    if (index < 0) return null;
    const target = chapters[index];
    if (target.hidden === hidden) return null;
    const affected = [chapterId];
    if (!target.subchapter) {
      for (let next = index + 1; next < chapters.length && chapters[next].subchapter; next += 1) affected.push(id(chapters[next].chapter_id));
    }
    const affectedIds = new Set(affected);
    return {
      affected,
      chapters: chapters.map((chapter) => affectedIds.has(id(chapter.chapter_id)) ? { ...chapter, hidden } : { ...chapter }),
    };
  };
  const runBookChapterVisibility = async (context, inputValue, args, hidden) => {
    const before = await listBookChapters(context, args);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    const expected = bookChapterVisibilityPlan(before.data.chapters, args.chapter_id, hidden);
    if (!expected) return error(hidden ? "moodle_book_chapter_already_hidden" : "moodle_book_chapter_already_visible");
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const endpoint = urlFor(rechecked, "/mod/book/show.php", { id: args.module_id, chapterid: args.chapter_id, sesskey: rechecked.sesskey });
    let response;
    try { response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "manual", headers: { Accept: "text/html" } }); } catch { return unconfirmedCreate(undefined, "moodle_book_chapter_visibility_response_unknown"); }
    if (response.type !== "opaqueredirect") {
      let redirect;
      try { redirect = new URL(response.headers.get("location") || "", endpoint); } catch { return unconfirmedCreate(response.status, "moodle_book_chapter_visibility_redirect_unconfirmed"); }
      const expectedRedirect = new URL(urlFor(rechecked, "/mod/book/view.php"));
      if (![301, 302, 303, 307, 308].includes(response.status) || redirect.origin !== expectedRedirect.origin || redirect.pathname !== expectedRedirect.pathname
        || redirect.searchParams.get("id") !== args.module_id || redirect.searchParams.get("chapterid") !== args.chapter_id) return unconfirmedCreate(response.status, "moodle_book_chapter_visibility_redirect_unconfirmed");
    }
    const after = await listBookChapters(rechecked, args);
    if (!after.ok) return unconfirmedCreate(response.status, "moodle_readback_unconfirmed");
    const chapter = after.data.chapters.find((entry) => id(entry.chapter_id) === args.chapter_id);
    const matches = stable(after.data.chapters) === stable(expected.chapters);
    const verification = { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_readback_mismatch" }) };
    return { ok: matches, sent: true, status: after.status, data: after.data, targets: bookTargets(rechecked, after.book, chapter), snapshot_digest: after.snapshot_digest, verification, ...(matches ? {} : { error: "moodle_write_not_verified" }) };
  };
  const bookChapterDeletePlan = (chapters, chapterId) => {
    const index = chapters.findIndex((chapter) => id(chapter.chapter_id) === chapterId);
    if (index < 0) return null;
    const removed = [chapters[index]];
    if (!chapters[index].subchapter) {
      for (let next = index + 1; next < chapters.length && chapters[next].subchapter; next += 1) removed.push(chapters[next]);
    }
    const removedIds = new Set(removed.map((chapter) => id(chapter.chapter_id)));
    const remaining = normaliseBookChapters(chapters.filter((chapter) => !removedIds.has(id(chapter.chapter_id))));
    return remaining ? { removed, remaining } : null;
  };
  const runBookChapterDelete = async (context, inputValue, args) => {
    const before = await listBookChapters(context, args);
    if (!before.ok) return before;
    if (before.snapshot_digest !== args.expected_digest) return error("moodle_expected_digest_mismatch");
    const expected = bookChapterDeletePlan(before.data.chapters, args.chapter_id);
    if (!expected) return error("moodle_book_chapter_delete_unavailable");
    if (expected.removed.some((chapter) => chapter.content_file_state === "unverified")) return error("moodle_book_chapter_files_unverified");
    const target = expected.removed[0];
    const rechecked = currentContext();
    if (!sameContext(context, rechecked) || validateBinding(rechecked, inputValue.binding)) return error("moodle_binding_mismatch");
    const preflight = await listBookChapters(rechecked, args);
    if (!preflight.ok) return preflight;
    if (preflight.snapshot_digest !== before.snapshot_digest) return error("moodle_form_changed");
    const endpoint = urlFor(rechecked, "/mod/book/delete.php", { id: args.module_id, chapterid: args.chapter_id, confirm: 1, sesskey: rechecked.sesskey });
    let response;
    try { response = await fetch(endpoint, { method: "GET", credentials: "include", cache: "no-store", redirect: "manual", headers: { Accept: "text/html" } }); } catch { return unconfirmedCreate(undefined, "moodle_book_chapter_delete_response_unknown"); }
    // Fetch exposes a manual same-origin redirect as an opaque redirect. The fixed native endpoint and the authoritative chapter-list readback bind that response without following the Book view.
    if (response.type !== "opaqueredirect") {
      let redirect;
      try { redirect = new URL(response.headers.get("location") || "", endpoint); } catch { return unconfirmedCreate(response.status, "moodle_book_chapter_delete_redirect_unconfirmed"); }
      const expectedRedirect = new URL(urlFor(rechecked, "/mod/book/view.php"));
      if (![301, 302, 303, 307, 308].includes(response.status) || redirect.origin !== expectedRedirect.origin || redirect.pathname !== expectedRedirect.pathname
        || redirect.searchParams.get("id") !== args.module_id || redirect.searchParams.has("chapterid")) return unconfirmedCreate(response.status, "moodle_book_chapter_delete_redirect_unconfirmed");
    }
    const after = await listBookChapters(rechecked, args);
    if (!after.ok) return unconfirmedCreate(response.status, "moodle_readback_unconfirmed");
    const matches = stable(after.data.chapters) === stable(expected.remaining);
    const verification = { schema: "morrow.browser-verification.v1", status: matches ? "verified" : "mismatch", ...(matches ? {} : { reason: "moodle_readback_mismatch" }) };
    return { ok: matches, sent: true, status: after.status, data: after.data, targets: bookTargets(rechecked, before.book, target), snapshot_digest: after.snapshot_digest, verification, ...(matches ? {} : { error: "moodle_write_not_verified" }) };
  };

  const context = currentContext();
  if (input?.mode === "probe") return context ? { ok: true, profile: context.profile } : error("moodle_session_unavailable");
  if (input?.mode === "discover_courses") {
    if (!context) return error("moodle_session_unavailable");
    if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) return error("moodle_execution_expired");
    const limit = input.limit === undefined ? 50 : input.limit;
    const offset = input.offset === undefined ? 0 : input.offset;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ITEMS
      || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_DISCOVERY_OFFSET) return error("moodle_arguments_invalid");
    try {
      const response = await ajax(context, "core_course_get_enrolled_courses_by_timeline_classification", { classification: "allincludinghidden", limit, offset, sort: null, customfieldname: null, customfieldvalue: null, searchvalue: null, requiredfields: [] });
      if (!response.ok || !isObject(response.data) || !Array.isArray(response.data.courses)) return error(response.error || "moodle_courses_invalid", { status: response.status });
      const timelineCourses = response.data.courses.slice(0, limit).map((course) => {
        const courseId = id(course?.id);
        const name = String(course?.fullname || course?.displayname || course?.shortname || "").trim().replace(/\s+/g, " ").slice(0, 500);
        return courseId && name ? { id: courseId, name } : null;
      });
      if (timelineCourses.some((course) => !course)) return error("moodle_courses_invalid", { status: response.status });
      let courses = timelineCourses;
      let emittedTimelineCount = timelineCourses.length;
      const currentCourseId = offset === 0 ? id(context.profile.courseId) : "";
      if (currentCourseId && !timelineCourses.some((course) => course.id === currentCourseId)) {
        const current = await state(context, currentCourseId);
        const named = current.ok ? await loadCourseName(context, currentCourseId) : null;
        if (named?.ok) {
          const currentCourse = { id: currentCourseId, name: named.name };
          if (timelineCourses.length >= limit) {
            courses = [currentCourse, ...timelineCourses.slice(0, limit - 1)];
            emittedTimelineCount = timelineCourses.length - 1;
          } else {
            courses = [currentCourse, ...timelineCourses];
          }
        }
      }
      const complete = response.data.courses.length < limit;
      const data = { courses, offset, limit, next_offset: complete ? null : offset + emittedTimelineCount, complete };
      return { ok: true, sent: true, status: response.status, data, snapshot_digest: await digest(data) };
    } catch {
      return error("moodle_courses_invalid");
    }
  }
  if (input?.mode === "check_course") {
    if (!context) return error("moodle_session_unavailable");
    if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) return error("moodle_execution_expired");
    const courseId = id(input.courseId);
    if (!courseId) return error("moodle_arguments_invalid");
    const current = await state(context, courseId);
    if (!current.ok) return error(current.error || "moodle_course_unavailable", { status: current.status });
    const course = await loadCourseName(context, courseId);
    if (!course.ok) return course;
    const data = { id: courseId, name: course.name };
    return { ok: true, sent: true, status: current.status, data, snapshot_digest: await digest(data) };
  }
  if (input?.mode !== "execute" || !context) return error("moodle_session_unavailable");
  if (!Number.isFinite(input.expiresAt) || Date.now() >= input.expiresAt) return error("moodle_execution_expired");
  const definition = expectedOperation(input.operation);
  if (!definition) return error("moodle_operation_refused");
  const bindingError = validateBinding(context, input.binding);
  if (bindingError) return error(bindingError);
  const checked = validateArguments(definition, input.arguments, input.binding, context);
  if (checked.error) return error(checked.error);
  const args = checked.value;
  try {
    if (definition.kind === "list-courses") {
      const response = await ajax(context, "core_course_get_enrolled_courses_by_timeline_classification", { classification: "allincludinghidden", limit: args.limit, offset: args.offset, sort: null, customfieldname: null, customfieldvalue: null, searchvalue: null, requiredfields: [] });
      if (!response.ok || !isObject(response.data) || !Array.isArray(response.data.courses)) return error(response.error || "moodle_courses_invalid", { status: response.status });
      const courses = sanitize(response.data.courses.slice(0, args.limit));
      const complete = response.data.courses.length < args.limit;
      const data = { courses, offset: args.offset, limit: args.limit, next_offset: complete ? null : args.offset + courses.length, complete };
      return { ok: true, sent: true, status: response.status, data, snapshot_digest: await digest(data) };
    }
    if (definition.kind === "structure" || definition.kind === "assignments" || definition.kind === "quizzes") return stateRead(context, args.course_id, definition.kind === "assignments" ? "assign" : definition.kind === "quizzes" ? "quiz" : "");
    if (definition.kind === "quiz-questions-read") {
      const result = await listQuizQuestions(context, input, args);
      if (!result.ok) return result;
      const { slots, ...output } = result;
      return output;
    }
    if (definition.kind === "quiz-question-read") return getQuizQuestion(context, input, args);
    if (definition.kind === "qbank-filter-inventory-read") return questionBankFilterInventory(context, args);
    if (definition.kind === "quiz-question-create-form-write") return runQuizQuestionCreation(context, input, args, definition.qtype);
    if (definition.kind === "quiz-question-write") return runQuizQuestionUpdate(context, input, args, definition.qtype);
    if (definition.kind === "resource-files-read") return getResourceFiles(context, input, args);
    if (definition.kind === "folder-files-read") return getFolderFiles(context, input, args);
    if (["resource-file-create-form-read", "folder-file-create-form-read", "imscp-package-create-form-read", "scorm-package-create-form-read"].includes(definition.kind)) {
      const form = definition.kind.startsWith("resource") ? await loadResourceFileCreationForm(context, args) : definition.kind.startsWith("folder") ? await loadFolderFileCreationForm(context, args) : definition.kind.startsWith("imscp") ? await loadImscpPackageCreationForm(context, args) : await loadScormPackageCreationForm(context, args);
      if (!form.ok) return form;
      return { ok: true, sent: true, status: form.status, data: form.data, targets: [courseTarget(context), sectionTarget(form.section)], snapshot_digest: form.snapshot_digest };
    }
    if (definition.kind === "resource-file-create-form-write") return runResourceFileCreation(context, input, args);
    if (definition.kind === "folder-file-create-form-write") return runFolderFileCreation(context, input, args);
    if (definition.kind === "resource-file-replace") return runResourceFileReplace(context, input, args);
    if (definition.kind === "resource-file-delete") return runResourceFileDelete(context, input, args);
    if (definition.kind === "folder-files-add") return runFolderFilesAdd(context, input, args);
    if (definition.kind === "folder-subfolder-create") return runFolderSubfolderCreate(context, input, args);
    if (definition.kind === "imscp-package-create-form-write") return runImscpPackageCreation(context, input, args);
    if (definition.kind === "scorm-package-create-form-write") return runScormPackageCreation(context, input, args);
    if (definition.kind === "book-chapters-read") return listBookChapters(context, args);
    if (definition.kind === "book-chapter-read") {
      const book = await bookBinding(context, args);
      if (!book.ok) return book;
      const form = await loadBookChapter(context, args, book, args.chapter_id);
      if (!form.ok) return form;
      return { ok: true, sent: true, status: form.status, data: form.data, targets: bookTargets(context, book, form.data), snapshot_digest: form.snapshot_digest };
    }
    if (definition.kind === "book-chapter-create-form-read") {
      const form = await loadBookChapterCreationForm(context, args);
      if (!form.ok) return form;
      return { ok: true, sent: true, status: form.status, data: { ...form.data, after_chapter_id: form.after_chapter_id || null, subchapter: form.subchapter }, targets: bookTargets(context, form.listed.book), snapshot_digest: form.snapshot_digest };
    }
    if (definition.kind === "book-chapter-create-form-write") return runBookChapterCreation(context, input, args);
    if (definition.kind === "book-chapter-form-write") return runBookChapterUpdate(context, input, args);
    if (definition.kind === "book-chapter-move") return runBookChapterMove(context, input, args);
    if (definition.kind === "book-chapter-show") return runBookChapterVisibility(context, input, args, false);
    if (definition.kind === "book-chapter-hide") return runBookChapterVisibility(context, input, args, true);
    if (definition.kind === "book-chapter-delete") return runBookChapterDelete(context, input, args);
    if (definition.kind === "assignment-overrides-read" || definition.kind === "quiz-overrides-read") {
      const module = overrideModule(definition.kind);
      const overrides = await overridesState(context, module, args.course_id, args.module_id);
      if (!overrides.ok) return overrides;
      return { ok: true, sent: true, status: overrides.status, data: overrides.data, targets: overrideTargets(context, module, overrides.name, "", overrides.data), snapshot_digest: overrides.snapshot_digest };
    }
    if (["assignment-override-create", "assignment-override-write", "quiz-override-create", "quiz-override-write"].includes(definition.kind)) return runOverrideWrite(context, input, definition, args);
    if (creationModule(definition.kind) && definition.kind.endsWith("form-read")) {
      const form = await loadCreationForm(context, args, definition.kind);
      if (!form.ok) return form;
      return { ok: true, sent: true, status: form.status, data: form.data, targets: formTargets(context, form.descriptor, form.data), snapshot_digest: form.snapshot_digest };
    }
    if (definition.kind.endsWith("form-read")) {
      const form = await loadForm(context, formDescriptor(context, definition.kind, args));
      if (!form.ok) return form;
      return { ok: true, sent: true, status: form.status, data: form.data, targets: formTargets(context, form.descriptor, form.data), snapshot_digest: form.snapshot_digest };
    }
    if (creationModule(definition.kind) && definition.kind.endsWith("form-write")) return runCreation(context, input, definition, args);
    if (definition.kind.includes("form-write") || definition.kind === "course-show" || definition.kind === "course-hide") return runFormWrite(context, input, definition, args);
    if (definition.kind === "activity-move") return runMoveActivity(context, input, args);
    return runVisibility(context, input, definition, args);
  } catch {
    return error("moodle_execution_failed");
  }
}
