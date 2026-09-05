# Moodle full functionality scope

Status: active implementation scope.  
Target: complete Moodle LMS 5.2 core functionality through Morrow's signed-in browser bridge, at the same task level as Canvas.  
Baseline: the current source has 31 Moodle operations. They are a partial checkpoint, not parity completion. Resource root-file metadata now has focused and live signed-in proof. The last verified private package, `7b09aaa21`, contains the preceding 30 operations.

This document is the implementation and acceptance list for the directive: **ALL MOODLE FUNCTIONALITY BUILT IN, JUST LIKE CANVAS.** It covers Moodle core administration as a target. It does not reduce scope to common educator tasks.

Dated bridge receipts and screenshots remain in [THREE-LMS-BRIDGE-PARITY.md](THREE-LMS-BRIDGE-PARITY.md). Do not duplicate their history here.

## Non-negotiable bridge contract

- Bind every request to one HTTPS Moodle site, installation subpath, signed-in principal, and exact course or system context.
- Keep Moodle session cookies, `sesskey`, draft IDs, file URLs, OAuth data, and secret form controls in Chrome. Do not return them through Morrow.
- Use a fixed, source-proven native form or same-site AJAX action. Do not use arbitrary URLs or caller-supplied form fields.
- Before every write, read the exact target, preserve protected native controls, show a human review, dispatch once, then read back the authoritative saved state. A dispatched mismatch or lost response is `applied_or_unknown`; it is never retried automatically.
- Treat native `view.php` routes as potentially effectful. An activity view can record completion, attendance, a launch, or other learner state. A read must use an established source that does not save course or learner state. Native settings reads can prepare private editor copies; disclose that behavior and keep the temporary identifiers internal.
- Enforce Moodle capabilities at the exact system, category, course, or module context. Do not infer authority from a role label. Moodle sites can override all standard roles and capabilities.

The current implementation already uses the signed-in page, validates the binding, keeps `sesskey` internal, and limits each approval to one dispatch. A workflow with several native effects must disclose and verify each effect. See [moodle-executor.js](../../connector/extension/src/moodle-executor.js) and [service-worker.js](../../connector/extension/src/service-worker.js). Moodle's Access API defines this context-and-capability model and requires course/activity login checks. [Access API](https://moodledev.io/docs/5.2/apis/subsystems/access)

## Current checkpoint

The generated catalog has 31 explicit Moodle operations: 16 reads and 15 writes. It provides these partial functions:

| Surface | Current capability | Completion gap |
|---|---|---|
| Course and structure | List signed-in courses; read course, course state, course summary, and one section | Course lifecycle, format settings, section lifecycle, course files, tags, custom fields, bulk edit, copy and deletion |
| Page | Read, create hidden, update title/content, show/hide, move | Attachments, full settings, completion/restrictions, duplicate/delete, learner evidence |
| Assignment | Read four dates; create hidden with date settings; edit title, instructions, and due date | Other date edits, submission settings, files, submissions, feedback, grading, overrides, rubrics, plagiarism, reports |
| Quiz | Read, create hidden, edit title/intro and open/close dates | Slots, all question writes, attempts, grading, reports, feedback, overrides, files |
| Quiz questions | List exact Quiz slots; read text Multiple choice and Essay in one exact slot | Question-bank scope, all other types, all question writes, versions, dependencies, random-slot behavior |
| Visibility and move | Show/hide course, section, and direct activity; move selected visible Page/Assignment/Quiz to a selected ordinary section | Full module coverage, nested/delegated structures, section and item ordering, duplicate/delete workflows |
| Files | Read complete root-file metadata for an exact Resource; protect empty native file managers; refuse nonempty or unverified areas before form writes | File upload, download, replace, delete, folders, editor attachments, and saved-byte verification |

The authoritative current list is [moodle-browser-catalog.json](../../connector/extension/generated/moodle-browser-catalog.json). It is a partial implementation list, not a Moodle feature inventory.

## Native route feasibility

| Route class | Native signed-in path | Required contract |
|---|---|---|
| Course structure | `core_courseformat_get_state` through Moodle's same-site AJAX service | Exact course binding, bounded state parsing, format-aware fields, readback after every structure change |
| Course and section settings | `/course/edit.php` and `/course/editsection.php` | One matching native POST form, all hidden controls preserved, final route checked, saved-form readback |
| Module settings | `/course/modedit.php` | One module-specific native form. The common controller is not a universal writer: each module needs its own field, file, validation, redirect, child-record, and result contract. [Controller source](https://github.com/moodle/moodle/blob/v5.2.2/public/course/modedit.php#L55-L209) |
| Quiz question inspection | Native Quiz edit and question-editor pages | Derive a question only from a freshly scoped Quiz slot. No caller question ID, arbitrary route, broad bank crawl, or shared-bank write |
| Native draft files | `/repository/draftfiles_ajax.php?action=list` | Bind exact draft area and root path; expose only approved metadata; never return draft IDs or URLs. [Draft source](https://github.com/moodle/moodle/blob/v5.2.2/public/repository/draftfiles_ajax.php#L34-L69) |
| Other core functions | Their rendered native form or documented same-site action | Establish the exact route, unique form identity, required controls, CSRF handling, postcondition, and authoritative readback before implementation. Do not substitute a bearer-token web service. |

Moodle's course-state API permits course-format-specific output classes and state actions. A custom format can therefore change the returned fields and affected objects. Every operation must validate the actual bound format rather than assume a fixed generic shape. [State source](https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/external/get_state.php#L50-L111), [action source](https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/external/update_course.php#L45-L123).

## Core module work list

Moodle 5.2 ships these 23 `mod` components. This is the required core activity and resource scope. Source: [Moodle 5.2 module tree](https://github.com/moodle/moodle/tree/v5.2.2/public/mod).

| Component | Status | Required workflows before complete |
|---|---|---|
| `assign` | Partial | Full settings; submission types and files; individual/group submissions; extensions; feedback; marking workflow; blind marking; grades; rubrics/marking guides; overrides; plagiarism; grading and submission reports |
| `bigbluebuttonbn` | Missing | Room settings, schedule, attendance/completion, recordings, participant/recording controls, and explicit protection from unreviewed external BigBlueButton effects |
| `book` | Missing | Settings, chapter and subchapter create/edit/reorder/delete, embedded files, import/export, print/display options |
| `choice` | Missing | Options, availability, limits, group mode, learner choices, response management, and response reporting |
| `data` | Missing | Fields, templates, presets, entries, approvals, comments, ratings, imports/exports, and activity reports |
| `feedback` | Missing | Question items, dependencies, templates, anonymous/non-anonymous submissions, analysis, and exports |
| `folder` | Missing | Folder settings, nested folders, file listing, upload/replace/delete/move, display/download behavior, and saved-file verification |
| `forum` | Missing | Forum settings, discussions, posts, replies, attachments, subscriptions, groups, ratings, moderation, and exports |
| `glossary` | Missing | Settings, categories, entries, aliases, attachments, approvals, comments, ratings, import/export, and display modes |
| `h5pactivity` | Missing | Content-bank selection, package file lifecycle, attempts, grades, completion, attempt reports, and external-content policy |
| `imscp` | Missing | Package file lifecycle, organization/navigation settings, display behavior, and saved package verification |
| `label` | Missing | Text and media editing, embedded files/media, placement, accessibility, restrictions, and completion behavior |
| `lesson` | Missing | Page and question graph, jumps, branches, attempts, grades, timers, imports/exports, and reports |
| `lti` | Missing | Tool configuration, deployment/resource link settings, grade/passback settings, privacy fields, launches, and external-effect confirmation |
| `page` | Partial | Attached files and media, all native settings, completion/restrictions, duplicate/delete, and learner-safe result checks |
| `qbank` | Missing | Shared-bank activity lifecycle, bank visibility, categories, question creation/versioning, preview, usage/dependency checks, imports/exports, and permissions |
| `quiz` | Partial | Full settings, question slots, random rules, question lifecycle, attempts, manual grading, regrade, overrides, feedback, reports, files, and grades |
| `resource` | Partial: root-file metadata read | Resource settings, main-file selection, files and folders, upload/replace/delete, display options, download/view checks, and saved-byte verification |
| `scorm` | Missing | Package file lifecycle, organization, attempts/tracking, grades, completion, reports, and package replacement rules |
| `subsection` | Missing | Subsection lifecycle, nested activity membership/order, delegated visibility, completion/restriction effects, and course-format readback |
| `url` | Missing | URL settings, external-link behavior, embedded parameters, display options, availability/completion, and no unreviewed external launch |
| `wiki` | Missing | Wiki settings, pages, revisions, locks, comments, attachments, maps, exports, and group modes |
| `workshop` | Missing | Setup, submission, allocation, assessment, grading, publication phases, rubrics, files, peer data, and reports |

For each module, completion means more than create and edit. It includes configuration, module-specific child content, learner activity where the module supports it, teacher/moderator action, grades or completion where supported, files, reports, deletion/duplication where Moodle supplies them, and strict saved-state readback.

## Question-bank and assessment work list

Moodle 5.2 has 17 authorable core question types. Source: [Moodle 5.2 question-type tree](https://github.com/moodle/moodle/tree/v5.2.2/public/question/type).

| Question types | Status | Required workflows |
|---|---|---|
| `calculated`, `calculatedmulti`, `calculatedsimple` | Missing | Formula/dataset authoring, validation, versioning, preview, import/export, and safe dataset dependency checks |
| `ddimageortext`, `ddmarker`, `ddwtos` | Missing | Rich content, images/files, drag targets, scoring, preview, versioning, and saved-file checks |
| `description` | Missing | Rich content, embedded files, placement, versioning, and preview |
| `essay` | Read-only, exact Quiz slot | Full question authoring/versioning, response templates/files, manual grading, bank/category operations, and usage checks |
| `gapselect`, `match`, `multianswer`, `multichoice`, `numerical`, `ordering`, `randomsamatch`, `shortanswer`, `truefalse` | Multiple choice is read-only in one exact Quiz slot; all other listed types are missing | Type-specific authoring, validation, choices/answers/tolerances, rich content/files, preview, versions, import/export, category movement, usage/dependency checks, and Quiz-slot lifecycle |

`missingtype` is a fallback for a type not installed. `tests` is not an authorable question type. Neither counts toward completion.

The full question scope also includes question banks and categories at every valid context, tags, history and versions, import/export, preview, permissions, Quiz slot order, random selection, dependency and usage analysis, attempts, grading, regrading, and reports. Moodle question writes can create a new version that affects latest-version references. No shared-bank question write is complete until the exact effect scope is proven.

## Cross-cutting core work list

| Surface | Status | Required workflows and authority |
|---|---|---|
| Files, repositories, editors, Content bank | Partial: Resource root metadata only | Other metadata reads; admitted bytes; upload, replace, move, delete, folders, aliases, embedded editor files, repository selection, H5P content, content-type checks, saved-byte readback. Require the relevant course/module file capability and repository policy. [File API](https://moodledev.io/docs/5.2/apis/subsystems/files/internals) |
| Gradebook and advanced grading | Missing | Grade categories/items, scales, outcomes, grade values, feedback, history, import/export, grading methods, Assignment/Quiz grade workflows, and learner-safe reads. Require `gradereport/grader:view`, `moodle/grade:viewall`, `moodle/grade:manage`, and module grading capabilities as applicable. |
| Participants, roles, enrolment | Missing | Bounded participant reads; enrol/suspend/unenrol; enrolment-method settings; role assignment/removal; cohorts; groups; groupings; group modes; imports. Enrolment method and role assignment are separate; full unenrolment can remove participation information. Require relevant enrolment, role, and course capabilities. [Enrolment API](https://moodledev.io/docs/5.2/apis/subsystems/enrol) |
| Groups and groupings | Missing | Group/grouping lifecycle, memberships, visibility, participation, course/activity modes, and imports. Require `moodle/course:managegroups`; enforce hidden-membership and separate-group access rules. [Groups API](https://moodledev.io/docs/5.2/apis/subsystems/group) |
| Calendar, dates, notifications | Missing | User, group, course, category, and activity events; create/edit/delete; subscriptions; import/export; reminders; timezone-correct forms. Preserve the user-configured civil timezone in reviews and readback. |
| Completion and restrictions | Missing | Course completion; manual, view, grade, and module-specific completion; availability by date, grade, group, profile, completion, and custom conditions. Verify the learner-visible postcondition without causing completion during reads. [Activity completion API](https://moodledev.io/docs/5.2/apis/core/activitycompletion) |
| Course settings and metadata | Partial | Full course settings, formats, images/files, tags, custom fields, language, groups, completion, start/end dates, copy, import/export, deletion, and category moves. Require the exact course/category capability. |
| Import, backup, restore, copy | Missing | Course import, backup selection, asynchronous progress, restore-file admission, restore mappings, course copy, cancellation, reports, and final target readback. Require `moodle/backup:*`, `moodle/restore:*`, and course-creation capability. [Backup API](https://moodledev.io/docs/5.2/apis/subsystems/backup) |
| Reports, logs, analytics, exports | Missing | Course/activity/grade/completion/progress/participation/log/security reports, Report builder, exports, scheduled outputs, and privacy bounds. Require the report capability and use bounded reads for learner data. |
| Messaging, badges, competencies, portfolios, plagiarism, comments, tags | Missing | Core settings and object lifecycle, learner/teacher actions, files where present, external-service effects, and reports. Each is capability and context scoped. |
| System administration | Missing | Categories; users; roles and permissions; cohorts; authentication; enrolment plugins; repositories; editors; filters; blocks; themes; languages; plugins; web services; site settings; security; privacy/policies; scheduled tasks; site reports; backup defaults. Require the exact system-context capability or administrator authorization. Never expose, replace, or synthesize secrets. |

## Capability families

Do not hard-code “teacher,” “manager,” or “administrator” as permission checks. Use the native capability that Moodle evaluates in the target context.

| Work | Capability family |
|---|---|
| View a course or activity | Active enrolment or `moodle/course:view`, plus the module view capability and availability checks |
| Edit course or sections | `moodle/course:update`; course creation is category-level `moodle/course:create` |
| Add or manage activities | `moodle/course:manageactivities` and the module's `mod/<component>:addinstance` or manage capability |
| Manage files | Course or module file-management capability, plus repository policy |
| Grade | `moodle/grade:*`, grade-report capability, and module-specific grade/manage/release capability |
| Manage groups | `moodle/course:managegroups`; view rights can be narrower because membership visibility is protected |
| Review/manage enrolments and roles | Enrolment-plugin authority, `moodle/course:enrolreview`, `moodle/course:enrolconfig`, and applicable `moodle/role:*` capability |
| Question bank | `moodle/question:*` plus bank/category context capability and Quiz management capability where relevant |
| Backup and restore | `moodle/backup:*`, `moodle/restore:*`, and target course/category authority |
| Site administration | System-context administration or the exact delegated capability; secrets remain non-exportable |

## Required implementation order

1. Retain the verified Resource root-file metadata path as the starting point for the file workflow. Its catalog, executor, focused tests, and signed-in live proof agree.
2. Establish the exact native discovery and read contracts needed by each workflow as it is built. Extend the existing form, binding, review, and result checks. Do not delay complete workflows to build every read operation first.
3. Build an end-to-end file workflow, then extend it to folders, attachments, and rich editors. Text-only question authoring can proceed while file contracts are researched. Both are dependencies for full resource, activity, question, feedback, and administration coverage.
4. Complete every resource and module lifecycle in the module table: create, read, edit, visibility, order, duplicate, delete, module-specific child data, files, and readback.
5. Complete Question bank and Quiz authoring, all 17 types, versions, dependencies, attempts, grading, feedback, and reports.
6. Complete learner and educator workflows: submissions, discussions, peer assessment, lessons, SCORM, H5P, LTI, conferencing, wikis, databases, feedback, and notifications.
7. Complete gradebook, enrolment, roles, groups, calendar, completion, restrictions, course lifecycle, import, backup, restore, copy, reports, and core administration.
8. Add installed-site plugin coverage only after an inventory of that site identifies each enabled optional component and its source, capability, form/action, file, external-effect, and verification contract.

This order is a dependency order. It does not remove later rows from the target.

## Test and proof requirements

For each new operation:

1. Add one compact local success test and one critical refusal or mismatch test when existing tests cannot cover the changed contract.
2. Test exact binding: origin, subpath, principal, course or system context, and module/object identity.
3. Test native form/action uniqueness, protected-field preservation, CSRF confinement, bounded response handling, and secret/draft stripping.
4. For writes, test reviewed inputs, pre-send stale-state refusal, one dispatch, authoritative saved-state readback, and replay refusal. Treat redirect, HTTP success, or a provider message as insufficient.
5. Run the focused tests, then the repository source gate after a coherent feature layer is complete.
6. Run a separate signed-in Moodle proof on an authorized disposable target for each write class. Record the exact target, request review, dispatch count, authoritative result, replay refusal, role/capability context, and limitation. A public-demo reset makes a receipt historical evidence, not ongoing tenant proof.
7. Test at least the standard editing-teacher path. Add a role-specific proof before claiming support for a different capability combination. Test a custom course format or refuse it until its effects are defined.
8. For files, grades, people, reports, backups, restores, and administration, prove data minimization and target scope before enabling broad reads or writes.

## Completion criteria

Moodle full functionality is complete only when all conditions below are true:

- Every one of the 23 core modules and every one of the 17 authorable core question types has a documented, implemented, tested, and live-proven capability matrix for its applicable author, learner, grading, file, completion, reporting, lifecycle, and deletion workflows.
- All cross-cutting rows in this document, including system administration, have equivalent contract and proof. Role and site authorization remain explicit in the product interface.
- Every enabled core operation binds the signed-in account and exact native target, preserves protected state, confines secrets, reads back the saved result, and refuses a replay or uncertain resend.
- Unsupported optional plugins are shown as unavailable until their installed-site inventory and proof are complete. Core completion never claims arbitrary third-party plugin coverage.
- The public and approval UI describe only the proven capability and role scope. Catalog totals and HTTP success do not count as parity proof.
- The dated evidence and remaining limits in [THREE-LMS-BRIDGE-PARITY.md](THREE-LMS-BRIDGE-PARITY.md) are updated when a row transitions from partial to complete.
