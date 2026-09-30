# Canvas and Moodle: platform mental models

Use the site's actual version, features, role, and plugins. This guide explains
platform concepts; the current Morrow catalog and policy decide dispatch
capability. Do not invent an operation because the platform documents one.

## Canvas

A course contains modules, pages, assignments, discussions, quizzes, files,
assignment groups, and course settings. A module item points to content; it is
not always the content object itself. Publication, availability, module
requirements, prerequisites, enrollment dates, and overrides can each affect
what a learner can reach. A valid object link does not prove student access.
Canvas may omit inline module items from a module response; use the admitted
items-list operation and complete pagination rather than assuming an empty list.

An assignment can have a due date and availability window, plus student,
section, or group overrides. Preserve override intent when changing dates.
Assignment-group weights and points have different effects on grades. Group
assignments, differentiated assignments, anonymous grading, and moderated
grading need specific evidence before changing them.

Classic Quizzes and New Quizzes use different objects and APIs. New Quizzes
has a parent assignment, quiz settings, and item interaction data. Classic
Question Banks are not New Quizzes Item Banks. Read the relevant contract
before editing; do not translate an ID or payload between those systems.
LTI or publisher content is a separate entitlement and launch boundary.

## Moodle

A course contains sections and activities/resources. Activity IDs, course-module
IDs, and context IDs are distinct; use the identifier the target function
requires. Site capabilities, roles, plugins, themes, and Moodle version affect
what is available. Do not infer administrator permission from a teacher role.

Distinguish activity completion, course completion, grades, and access
restrictions. They can interact, but completing an activity does not itself
prove a passing grade or course completion. Check site and course enablement,
conditions, grade thresholds, and restrictions before diagnosing a blocked
learner route. Backups/restores can include learner data and role assignments;
choose content-only options deliberately and inspect restored links/settings.

The packaged Moodle module uses an in-memory HTTPS session and sesskey.
Its session handoff and production write governance limits are stated in
[the Moodle skill](../moodle/SKILL.md). A sesskey is sensitive session material,
not an agent-visible configuration value. Never persist or reveal it.

## Translate intent, not payloads

“Make a weekly module” may mean a Canvas module or a Moodle course section.
“Quiz bank” may refer to different systems. Clarify only when the distinction
changes the result. Resolve the correct platform object, capability, and
permissions before dispatch. Never use Canvas field names against Moodle.

Primary references, checked 2026-09-30:
- [Canvas Modules API](https://developerdocs.instructure.com/services/canvas/resources/modules)
- [Canvas Assignments API](https://developerdocs.instructure.com/services/canvas/resources/assignments)
- [Moodle activity completion](https://docs.moodle.org/502/en/Activity_completion)
- [Moodle course backup](https://docs.moodle.org/402/en/backup/backup)
Match Moodle documentation to the deployed site's version; these links are
reference examples, not a declaration that every site runs that version.
