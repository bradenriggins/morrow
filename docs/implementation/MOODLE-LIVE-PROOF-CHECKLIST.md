# Moodle live-proof checklist

Every Moodle write in the shipped catalog, the proof fields its receipt must carry, and the evidence that exists for it today.

This file is generated. Run `node scripts/moodle-live-proof.mjs --write-checklist` after any change to `connector/extension/generated/moodle-browser-catalog.json`, to the Moodle capability surface in `README.md`, or to the receipts named in `docs/implementation/THREE-LMS-BRIDGE-PARITY.md`. `scripts/test/moodle-live-proof.test.mjs` fails when it drifts.

## The harness

`scripts/moodle-live-proof.mjs` runs one write end to end and writes the receipt:

```
node scripts/moodle-live-proof.mjs --operation=moodle_update_label \
  --arguments='{"module_id":11,"content":"<p>Reviewed fixture text</p>"}'
```

It drives the shipped gateway, the shipped bridge protocol, the shipped page executor and the shipped approval server. It plays the connector role itself, so the packaged extension service worker does not run, and every receipt records that.

`--target=fixture` is the default and serves a local HTTPS Moodle fixture for the one write class named below. Nothing reaches a Moodle site. `--target=site --site=<https origin> --chrome-profile=<directory> --course-id=<id>` runs the same path against an authorized disposable Moodle site, which this machine does not have.

`--fixture-fault=lost-response` makes the fixture save the change and answer nothing. The proof then ends `failed` with `applied_or_unknown`, one dispatch, and a refused replay. A saved change with no answer is never a passed proof.

## Required proof fields

A receipt is complete when it carries all of these. The harness writes each one:

| Receipt field | What it proves |
| --- | --- |
| `target` | The exact site, installation subpath, signed-in principal and course the write bound to. |
| `exactTargetBeforeChange` | The fresh read of the exact target, with the snapshot digest the change was bound to. |
| `requestReview` | The frozen request a person approved, its authorization, and the refusal of a dispatch before approval. |
| `dispatch` | One dispatch: `dispatchAttempt: 1`, one bridge write command, and one provider POST or AJAX call. |
| `authoritativeSavedResult` | The fresh read after the change, from Moodle's own saved state, and the fields that changed. |
| `replay` | The refusal of the repeated dispatch, and the unchanged dispatch count after it. |
| `roleAndCapability` | The role of the account that ran it and the Moodle capability the catalog states for the operation. |
| `evidenceClass` | `local_fixture` or `signed_in_site`. A fixture receipt is never tenant evidence. |

## Write classes

- **native form** (108 operations). Moodle's own `mod_form` or `edit.php` POST. The proof must show the reloaded form immediately before the POST, exactly one POST, and the fresh native settings read after it.
- **same-site AJAX** (17 operations). Moodle's own `/lib/ajax/service.php` method. The proof must show the exact method name, exactly one call, and the fresh state read after it.

The local fixture in the harness serves one write class today: `moodle.form.course.modedit.label.write.v1`, the Text and media area content edit. Every other write needs an authorized disposable Moodle site.

A write that carries reviewed local file bytes is planned through its own `morrow_plan_moodle_*` tool, not through `morrow_capability_change`. The harness has no local file staging step, so it cannot yet run these 8 writes on any target: `moodle_add_folder_files`, `moodle_create_folder_file`, `moodle_create_h5pactivity`, `moodle_create_imscp_package`, `moodle_create_resource_file`, `moodle_create_scorm_package`, `moodle_replace_resource_file`, `moodle_replace_scorm_package`.

## Every catalog write

125 writes, from `connector/extension/generated/moodle-browser-catalog.json`.

| Tool | Class | Review read | Capability stated in the catalog | Current evidence |
| --- | --- | --- | --- | --- |
| `moodle_add_folder_files` | native form | `moodle_get_folder_files` | `moodle/course:manageactivities` | fixture-only |
| `moodle_add_group_member` | native form | `moodle_get_course_groups` | `moodle/course:managegroups` | fixture-only |
| `moodle_add_qbank_question_to_quiz` | native form | `moodle_get_qbank_quiz_slot_plan` | `mod/quiz:manage`, `moodle/question:use` | fixture-only |
| `moodle_assign_role` | same-site AJAX | `moodle_get_course_participants` | `moodle/course:viewparticipants`, `moodle/course:enrolreview`, `moodle/role:assign` | fixture-only |
| `moodle_change_course_format` | native form | `moodle_get_course_settings` | `moodle/course:update` | fixture-only |
| `moodle_copy_course` | native form | `moodle_get_course_settings` | `moodle/backup:backupcourse`, `moodle/restore:restorecourse`, `moodle/course:create` | fixture-only |
| `moodle_create_assignment` | native form | `moodle_get_assignment_creation_form` | not stated; record the capability observed at proof time | signed-in checked, receipts in [the parity record](THREE-LMS-BRIDGE-PARITY.md) |
| `moodle_create_assignment_override` | native form | `moodle_get_assignment_overrides` | `mod/assign:manageoverrides` | fixture-only |
| `moodle_create_bigbluebuttonbn` | native form | `moodle_get_bigbluebuttonbn_creation_form` | `moodle/course:manageactivities`, `mod/bigbluebuttonbn:addinstance` | fixture-only |
| `moodle_create_book` | native form | `moodle_get_book_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_create_book_chapter` | native form | `moodle_get_book_chapter_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_create_choice` | native form | `moodle_get_choice_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_create_course_event` | same-site AJAX | `moodle_list_course_events` | `moodle/calendar:manageentries` | fixture-only |
| `moodle_create_database` | native form | `moodle_get_database_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_create_database_field` | native form | `moodle_get_database_fields` | `mod/data:managetemplates` | fixture-only |
| `moodle_create_feedback` | native form | `moodle_get_feedback_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_create_feedback_item` | native form | `moodle_get_feedback_items` | `mod/feedback:edititems` | fixture-only |
| `moodle_create_folder_file` | native form | `moodle_get_folder_file_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_create_folder_subfolder` | native form | `moodle_get_folder_files` | `moodle/course:manageactivities` | fixture-only |
| `moodle_create_forum` | native form | `moodle_get_forum_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_create_forum_discussion` | native form | `moodle_get_forum_post_target` | `mod/forum:startdiscussion` | fixture-only |
| `moodle_create_glossary` | native form | `moodle_get_glossary_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_create_glossary_entry` | native form | `moodle_list_glossary_entries` | `mod/glossary:write` | fixture-only |
| `moodle_create_group` | native form | `moodle_get_course_groups` | `moodle/course:managegroups` | fixture-only |
| `moodle_create_grouping` | native form | `moodle_get_course_groupings` | `moodle/course:managegroups` | fixture-only |
| `moodle_create_h5pactivity` | native form | `moodle_get_h5pactivity_creation_form` | `moodle/course:manageactivities` | fixture-only |
| `moodle_create_imscp_package` | native form | `moodle_get_imscp_package_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_create_label` | native form | `moodle_get_label_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_create_lesson` | native form | `moodle_get_lesson_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_create_lesson_page` | native form | `moodle_list_lesson_pages` | `mod/lesson:edit`, `mod/lesson:manage` | fixture-only |
| `moodle_create_lti` | native form | `moodle_get_lti_creation_form` | `moodle/course:manageactivities`, `mod/lti:addpreconfiguredinstance` | fixture-only |
| `moodle_create_page` | native form | `moodle_get_page_creation_form` | not stated; record the capability observed at proof time | signed-in checked, receipts in [the parity record](THREE-LMS-BRIDGE-PARITY.md) |
| `moodle_create_qbank_activity` | native form | `moodle_get_qbank_activity_creation_form` | `moodle/course:manageactivities` | fixture-only |
| `moodle_create_qbank_question` | native form | `moodle_get_qbank_question_creation_form` | `moodle/question:add` | fixture-only |
| `moodle_create_quiz` | native form | `moodle_get_quiz_creation_form` | not stated; record the capability observed at proof time | signed-in checked, receipts in [the parity record](THREE-LMS-BRIDGE-PARITY.md) |
| `moodle_create_quiz_override` | native form | `moodle_get_quiz_overrides` | `mod/quiz:manageoverrides` | fixture-only |
| `moodle_create_resource_file` | native form | `moodle_get_resource_file_creation_form` | not stated; record the capability observed at proof time | signed-in checked, receipts in [the parity record](THREE-LMS-BRIDGE-PARITY.md) |
| `moodle_create_scorm_package` | native form | `moodle_get_scorm_package_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_create_section` | same-site AJAX | `moodle_get_contents` | `moodle/course:update` | fixture-only |
| `moodle_create_subsection` | native form | `moodle_get_contents` | `moodle/course:manageactivities`, `mod/subsection:addinstance` | fixture-only |
| `moodle_create_url` | native form | `moodle_get_url_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_create_wiki` | native form | `moodle_get_wiki_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_create_workshop` | native form | `moodle_get_workshop_creation_form` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_delete_activity` | same-site AJAX | `moodle_get_contents` | `moodle/course:manageactivities` | fixture-only |
| `moodle_delete_book_chapter` | native form | `moodle_list_book_chapters` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_delete_event` | same-site AJAX | `moodle_get_event` | `moodle/calendar:manageentries` | fixture-only |
| `moodle_delete_group` | native form | `moodle_get_course_groups` | `moodle/course:managegroups` | fixture-only |
| `moodle_delete_lesson_page` | native form | `moodle_list_lesson_pages` | `mod/lesson:edit`, `mod/lesson:manage` | fixture-only |
| `moodle_delete_resource_file` | native form | `moodle_get_resource_files` | `moodle/course:manageactivities` | fixture-only |
| `moodle_delete_section` | same-site AJAX | `moodle_get_contents` | `moodle/course:update`, `moodle/course:movesections` | fixture-only |
| `moodle_duplicate_activity` | same-site AJAX | `moodle_get_contents` | `moodle/course:manageactivities`, `moodle/backup:backuptargetimport`, `moodle/restore:restoretargetimport` | fixture-only |
| `moodle_enrol_participant` | native form | `moodle_get_course_participants` | `moodle/course:viewparticipants`, `moodle/course:enrolreview`, `enrol/manual:enrol` | fixture-only |
| `moodle_hide_activity` | same-site AJAX | `moodle_get_contents` | not stated; record the capability observed at proof time | signed-in checked, receipts in [the parity record](THREE-LMS-BRIDGE-PARITY.md) |
| `moodle_hide_book_chapter` | native form | `moodle_list_book_chapters` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_hide_course` | native form | `moodle_get_course_summary` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_hide_section` | same-site AJAX | `moodle_get_contents` | not stated; record the capability observed at proof time | signed-in checked, receipts in [the parity record](THREE-LMS-BRIDGE-PARITY.md) |
| `moodle_lock_forum_discussion` | native form | `moodle_get_forum_post_target` | `moodle/course:manageactivities` | fixture-only |
| `moodle_move_activity` | same-site AJAX | `moodle_get_contents` | not stated; record the capability observed at proof time | signed-in checked, receipts in [the parity record](THREE-LMS-BRIDGE-PARITY.md) |
| `moodle_move_activity_to_position` | same-site AJAX | `moodle_get_contents` | `moodle/course:manageactivities` | fixture-only |
| `moodle_move_book_chapter` | native form | `moodle_list_book_chapters` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_move_lesson_page` | native form | `moodle_list_lesson_pages` | `mod/lesson:edit`, `mod/lesson:manage` | fixture-only |
| `moodle_move_section` | same-site AJAX | `moodle_get_contents` | `moodle/course:movesections` | fixture-only |
| `moodle_pin_forum_discussion` | native form | `moodle_get_forum_post_target` | `mod/forum:pindiscussions` | fixture-only |
| `moodle_realize_qbank_default_category` | native form | `moodle_get_qbank_activity` | `moodle/question:add` | fixture-only |
| `moodle_remove_group_member` | native form | `moodle_get_course_groups` | `moodle/course:managegroups` | fixture-only |
| `moodle_remove_quiz_slot` | native form | `moodle_get_quiz_structure` | `mod/quiz:manage` | fixture-only |
| `moodle_remove_role` | same-site AJAX | `moodle_get_course_participants` | `moodle/course:viewparticipants`, `moodle/course:enrolreview`, `moodle/role:assign` | fixture-only |
| `moodle_reorder_quiz_slot` | native form | `moodle_get_quiz_structure` | `mod/quiz:manage` | fixture-only |
| `moodle_replace_resource_file` | native form | `moodle_get_resource_files` | `moodle/course:manageactivities` | fixture-only |
| `moodle_replace_scorm_package` | native form | `moodle_get_scorm` | `moodle/course:manageactivities` | fixture-only |
| `moodle_reply_to_forum_post` | native form | `moodle_get_forum_post_target` | `mod/forum:replypost` | fixture-only |
| `moodle_set_activity_group_mode` | same-site AJAX | `moodle_get_contents` | `moodle/course:manageactivities`, `moodle/course:managegroups` | fixture-only |
| `moodle_set_forum_subscription` | native form | `moodle_get_forum_post_target` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_set_grouping_groups` | native form | `moodle_get_course_groupings` | `moodle/course:managegroups` | fixture-only |
| `moodle_set_quiz_page_break` | native form | `moodle_get_quiz_structure` | `mod/quiz:manage` | fixture-only |
| `moodle_set_quiz_slot_mark` | native form | `moodle_get_quiz_structure` | `mod/quiz:manage` | fixture-only |
| `moodle_show_activity` | same-site AJAX | `moodle_get_contents` | not stated; record the capability observed at proof time | signed-in checked, receipts in [the parity record](THREE-LMS-BRIDGE-PARITY.md) |
| `moodle_show_book_chapter` | native form | `moodle_list_book_chapters` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_show_course` | native form | `moodle_get_course_summary` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_show_section` | same-site AJAX | `moodle_get_contents` | not stated; record the capability observed at proof time | signed-in checked, receipts in [the parity record](THREE-LMS-BRIDGE-PARITY.md) |
| `moodle_start_course_backup` | native form | `moodle_list_backup_files` | `moodle/backup:backupcourse` | fixture-only |
| `moodle_start_course_import` | native form | `moodle_get_contents` | `moodle/restore:restoretargetimport`, `moodle/backup:backuptargetimport` | fixture-only |
| `moodle_start_course_restore` | native form | `moodle_list_backup_files` | `moodle/restore:restorecourse` | fixture-only |
| `moodle_suspend_participant` | native form | `moodle_get_course_participants` | `moodle/course:viewparticipants`, `moodle/course:enrolreview`, `enrol/manual:manage` | fixture-only |
| `moodle_unenrol_participant` | native form | `moodle_get_course_participants` | `moodle/course:viewparticipants`, `moodle/course:enrolreview`, `enrol/manual:unenrol` | fixture-only |
| `moodle_update_activity_completion` | native form | `moodle_get_activity_completion` | `moodle/course:manageactivities` | fixture-only |
| `moodle_update_activity_restrictions` | native form | `moodle_get_activity_restrictions` | `moodle/course:manageactivities` | fixture-only |
| `moodle_update_assignment` | native form | `moodle_get_assignment` | `moodle/course:manageactivities` | signed-in checked, receipts in [the parity record](THREE-LMS-BRIDGE-PARITY.md) |
| `moodle_update_assignment_override` | native form | `moodle_get_assignment_overrides` | `mod/assign:manageoverrides` | fixture-only |
| `moodle_update_book` | native form | `moodle_get_book` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_book_chapter` | native form | `moodle_get_book_chapter` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_choice` | native form | `moodle_get_choice` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_choice_option` | native form | `moodle_get_choice_options` | `moodle/course:manageactivities` | fixture-only |
| `moodle_update_course_completion` | native form | `moodle_get_course_completion` | `moodle/course:update` | fixture-only |
| `moodle_update_course_settings` | native form | `moodle_get_course_settings` | `moodle/course:update` | fixture-only |
| `moodle_update_course_summary` | native form | `moodle_get_course_summary` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_database` | native form | `moodle_get_database` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_database_field` | native form | `moodle_get_database_fields` | `mod/data:managetemplates` | fixture-only |
| `moodle_update_event` | same-site AJAX | `moodle_get_event` | `moodle/calendar:manageentries` | fixture-only |
| `moodle_update_feedback` | native form | `moodle_get_feedback` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_feedback_item` | native form | `moodle_get_feedback_items` | `mod/feedback:edititems` | fixture-only |
| `moodle_update_forum` | native form | `moodle_get_forum` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_glossary` | native form | `moodle_get_glossary` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_glossary_entry` | native form | `moodle_get_glossary_entry` | `mod/glossary:write`, `mod/glossary:manageentries`, `mod/glossary:approve` | fixture-only |
| `moodle_update_grade_category` | native form | `moodle_get_grade_category` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_grade_category_settings` | native form | `moodle_get_grade_category` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_grade_item` | native form | `moodle_get_grade_item` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_grade_item_settings` | native form | `moodle_get_grade_item` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_group` | native form | `moodle_get_course_groups` | `moodle/course:managegroups` | fixture-only |
| `moodle_update_grouping` | native form | `moodle_get_course_groupings` | `moodle/course:managegroups` | fixture-only |
| `moodle_update_h5pactivity` | native form | `moodle_get_h5pactivity` | `moodle/course:manageactivities` | fixture-only |
| `moodle_update_label` | native form | `moodle_get_label` | not stated; record the capability observed at proof time | signed-in checked, `output/live-moodle/moodle-label-live-2026-09-06T02-31-49-096Z-receipt.json` |
| `moodle_update_lesson` | native form | `moodle_get_lesson` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_lesson_page` | native form | `moodle_list_lesson_pages` | `mod/lesson:edit`, `mod/lesson:manage` | fixture-only |
| `moodle_update_lti` | native form | `moodle_get_lti` | `moodle/course:manageactivities` | fixture-only |
| `moodle_update_page` | native form | `moodle_get_page` | not stated; record the capability observed at proof time | signed-in checked, receipts in [the parity record](THREE-LMS-BRIDGE-PARITY.md) |
| `moodle_update_quiz` | native form | `moodle_get_quiz` | `moodle/course:manageactivities` | signed-in checked, receipts in [the parity record](THREE-LMS-BRIDGE-PARITY.md) |
| `moodle_update_quiz_override` | native form | `moodle_get_quiz_overrides` | `mod/quiz:manageoverrides` | fixture-only |
| `moodle_update_scorm` | native form | `moodle_get_scorm` | `moodle/course:manageactivities` | fixture-only |
| `moodle_update_section` | native form | `moodle_get_section` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_section_restrictions` | native form | `moodle_get_section_restrictions` | `moodle/course:update` | fixture-only |
| `moodle_update_url` | native form | `moodle_get_url` | not stated; record the capability observed at proof time | signed-in checked, `output/live-moodle/moodle-url-live-2026-09-06T03-19-28-814Z-receipt.json` |
| `moodle_update_wiki` | native form | `moodle_get_wiki` | not stated; record the capability observed at proof time | fixture-only |
| `moodle_update_wiki_page` | native form | `moodle_get_wiki_page` | `mod/wiki:editpage` | fixture-only |
| `moodle_update_workshop` | native form | `moodle_get_workshop` | not stated; record the capability observed at proof time | fixture-only |

## What a fixture receipt does not establish

- Any signed-in Moodle behaviour. A fixture receipt proves the harness, the gateway, the approval path and the page executor against markup this repository serves.
- Any role other than the one the receipt names.
- Learner-visible outcomes: completion, restrictions, launches, and visibility to students.
- The packaged extension. The harness plays the connector role itself.
