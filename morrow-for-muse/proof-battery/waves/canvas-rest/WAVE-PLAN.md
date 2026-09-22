# Canvas REST live-proof battery: wave plan

Date: 2026-09-21. Worktree: `~/workspace/morrow-for-muse-deploy/`.
Scope: Canvas REST operations with transport `canvas-batch`, status pending,
NOT learner-data flagged. In scope: **266 ops**. Gated (learner-data, not
live-tested until the tokenization boundary lands): 142 ops. Blocked
separate track (quiz-api-token, 18 ops): awaiting Braden's decision.

Transport: browser-task form lane only (GET navigations + relay-page form
POST/PUT/DELETE with `_method` overrides, CSRF harvested in-page and never
reported). The browser task cannot execute page-context JavaScript (verified
by probe 2026-09-21), so anything needing custom headers, JSON bodies, or
PATCH is out of the form lane.

## Execution rules (every wave)

1. Target course is 89585 (BIOL 101) unless the wave says otherwise.
2. Session check first (`/api/v1/users/self` must show id 28206, Braden Riggins);
   on `session_dead` the whole wave stops, nothing is attempted.
3. Every write uses a disposable object named `Morrow Proof ... (delete me)`.
4. Every write ends deleted with a verify-gone readback (expect 404).
5. Nothing student-visible may change: no announcements, no messages to
   people, no support tickets, no subaccount effects, no publishing of test
   objects to students.
6. One browser task at a time (shared browser profile). A wave's part B
   runs only after part A's report is in, when IDs carry across.
7. Evidence per wave: sanitized fixture (RESULTS_JSON bodies only, no
   tokens/cookies) at `proof-battery/evidence/canvas-rest-waveN/`.
8. Catalog feedback: add entries to the `E` evidence map in
   `proof-battery/build_catalog.py`, re-run it, and diff
   `OPERATION_CATALOG.md` to confirm only the intended rows changed.
   CAUTION: the .md currently carries hand-applied 2026-09-21 audit
   amendments; verify those amendments exist in build_catalog.py's E map
   BEFORE regenerating, or the regeneration will clobber them.

## Wave list (execution order)

### Wave 1: assignments (14 ops) -- RENDERED
Briefs: `wave-1/brief-wave1a-assignments.md` (14 ops, concrete),
`wave-1/brief-wave1b-assignments.md` (10 ops, needs {A}/{S} from 1A).
Render script: `wave-1/render_wave1.py`.
Proves: C-34, C-35, C-36 (batch overrides), C-37 (bulk dates), C-39,
C-41, C-42, C-45, C-46, C-47, C-48, C-49, C-50, C-51. C-38/C-40/C-43/C-44
already live-proven; re-exercised as lifecycle anchors, not re-claimed.
Helper: sections-list (credited to Wave 8) runs inside 1A to get {S}.
Run 1B only after 1A's report delivers {A} and {S}.

### Wave 2: pages (8) + modules (12) = 20 ops -- 2 briefs
Page lifecycle: create -> show -> list -> update -> duplicate ->
delete duplicate -> delete -> verify gone (C-1xx page ops pending).
Module lifecycle: create -> show -> list -> update -> create item ->
show/list/update item -> delete item -> delete module -> verify gone.
Note: front-page PUT stays excluded (student-visible home page), as in C1.

### Wave 3: files (14) + media_objects (2) = 16 ops -- 2 briefs
Reads against EXISTING course files (resolve path, get file, read text,
quota, licenses, date_details). Disposable folder create; folder cleanup
via DELETE /api/v1/folders/:id (standard Canvas endpoint, cleanup only,
not a catalog proof claim since no folder-delete op is catalogued).
C-130 (file upload POST): probe-only, multipart upload is not expressible
through the relay page; a clean provider refusal is a valid result.
C-200/C-203 (usage rights DELETE/PUT): PARENT DECISION, course-wide
mutation risk; do not run without explicit approval.

### Wave 4: classic quizzes (7) + quiz_questions (5) + quiz_question_groups (6) = 18 ops -- 2 briefs
Quiz lifecycle: create -> show -> list -> update -> create question ->
show/list/update question -> create question group -> delete question ->
delete quiz -> verify gone. Classic quizzes only; New Quizzes are Wave 15.

### Wave 5: rubrics (14) -- 1-2 briefs
Rubric lifecycle: create -> show -> list -> update -> delete ->
verify gone, against the disposable Wave 1-style assignment or a fresh
disposable assignment created inside this wave.

### Wave 6: outcomes (1) + outcome_groups (13) + outcome_imports (3) + proficiency_ratings (2) = 19 ops -- 2 briefs
Outcome group tree: create group -> create outcome in group -> show/list ->
update -> move/delete -> verify gone. Import/status reads are GET-only.

### Wave 7: grading_standards (5) + grading_periods (5) + late_policy (3) + assignment_groups (5) = 18 ops -- 2 briefs
Grading standard + grading period + assignment group lifecycles, all
disposable with delete + verify gone.
BLOCKED-ON-PLATFORM-PRIMITIVE: C-210 (PATCH batch_update grading
periods) and C-230 (PATCH late policy). The form lane validates
GET/POST/PUT/DELETE only; PATCH is rejected by render_brief. These two
wait for the script-execution/fetch primitive (platform ask drafted
2026-09-21). Do not force them into form briefs.

### Wave 8: sections (3) + groups (2) + group_categories (6) = 11 ops -- 1 brief
Sections list may already be credited from the Wave 1A helper; skip if so.
Group category lifecycle: create -> list -> create group in category ->
delete group -> delete category -> verify gone.

### Wave 9: calendar_events (3) + blackout_dates (7) + course_pace (4) = 14 ops -- 1-2 briefs
Calendar event + blackout date lifecycles, disposable with delete +
verify gone. Course pace GETs are reads; pace writes run only against
disposable objects.

### Wave 10: tabs (2) + external_tools (7) + lti_launch_definitions (1) + lti_resource_links (6) + collaborations (2) + conferences (1) = 19 ops -- 2 briefs
External tool lifecycle: create (disposable test tool config) -> show ->
list -> update -> delete -> verify gone. Tab reads are GET-only.
Collaboration/conference ops are reads here; creation ops that would
notify users stay out.

### Wave 11: content_migrations (10) + content_exports (3) + epub_exports (2) + course_reports (3) = 18 ops -- 2 briefs
Migration/export/report STATUS and LIST reads first. The migration CREATE
(POST) kicks off a real background job: run it only as a minimal
disposable migration, poll status, and record honestly. If the job type
cannot be made disposable, mark C-83 probe-only.

### Wave 12: courses GETs (17 ops) -- 2 GET-only briefs
Activity stream, todo, settings (read), permissions, users/students
lists, content share users, test student, course copy status. Pure reads,
no writes, no cleanup needed.
NOT IN SCOPE (destructive or account-level):
- C-104 copy course content, C-124 reset course, C-125 restore syllabus
  version: EXCLUDED, destructive to course 89585.
- C-128 update course, C-129 update course settings: PARENT DECISION.
  Student-visible course mutation; only runnable as rename-and-revert
  with explicit approval.
- C-122 preview_html, C-123 dismiss migration alert: probe-only.
- C-130 file upload: probe-only (multipart).

### Wave 13: ai_experiences (9) -- 1 brief
AI experience lifecycle: create -> show -> list -> update -> delete ->
verify gone. Student conversation reads stay out (learner-data gated).

### Wave 14: misc reads + learning_object_dates GETs -- 2 GET-only briefs
Single-GET resources: announcement_external_feeds (list), blockeditor
template, brand config, CSP setting, feature flags, blueprint course
reads, quiz assignment overrides, quiz IP filters, SIS integration,
smart search, learning_object_dates GETs (6).
learning_object_dates PUTs (5): DEFERRED. They mutate dates on existing
objects; they run only in a later wave against a disposable dated
object created fresh in that wave.
announcement_external_feeds POST/DELETE: disposable feed lifecycle,
delete + verify gone (no notifications involved).

### Wave 15: new-quizzes Canvas REST reads (5 GETs) -- 1 GET-only brief
C-292, C-294, C-295, C-291, C-293 (media upload URL, get/list quiz and
items; item GET needs a quiz+item id, use existing course quizzes or
record a clean 404).
Writes BLOCKED: C-287/C-288/C-296/C-297 (POST) create real New Quizzes
whose cleanup requires quiz-api DELETE (Authorization header ->
platform primitive, blocked track). C-289/C-290 (DELETE) and C-298/C-299
(PATCH) likewise. Do not create New Quizzes that cannot be deleted.

## Explicitly out of the battery

- 142 learner-data flagged ops: GATED until the tokenization boundary lands.
- 8 catalog-excluded ops (C-60, C-69, C-72, C-93, C-189, C-190, C-366, C-401):
  blueprint pushes, feature flags, quiz messages, SIS export.
- C-108 delete/conclude course: evidence-hold; would destroy the test course.
- C-104, C-124, C-125: destructive to course 89585 (see Wave 12).
- 18 quiz-api-token ops + all Item Bank ops: blocked track, awaiting
  Braden's Mac-rig-vs-defer decision.
- study_assist POST (C-404): PARENT DECISION; creates AI study content on
  the live course.
- Moodle ops: separate track (Moodle battery re-passed 2026-09-21 for
  forum discussions; remaining Moodle ops triaged separately).

## Wave status log

| Wave | Briefs | Status |
|------|--------|--------|
| 1 assignments | rendered (1a concrete, 1b needs 1A ids) | ready to run |
| 2-15 | to be rendered per wave | planned |

## 2026-09-21 write-lane blocker (appended, original plan above unchanged)

Wave 1A ran live tonight through the browser task. Result: the 4
placeholder-free GET ops returned 200 (list assignments, sections list, user
assignments), but EVERY relay-page write op was skipped with
`csrf_unavailable`: the browser task's automation toolset has no
cookie-reading capability and no JavaScript execution (verified by direct
probe earlier tonight), so the `_csrf_token` cannot be harvested and the
relay page cannot be submitted. Nothing was created or modified; the
wave-end cleanup condition held trivially.

Finding: the relay-page write lane is DEAD for browser-task execution.
The writes it was designed to carry (all of waves 1-15, plus the Item Bank
and New Quiz batteries) cannot run on this VM through any browser-task
mechanism. The remaining write paths are: (a) the Mac-rig CDP rig
(Braden's standing rule forbids it without his explicit word), or (b) the
platform primitive (script execution / session-bound fetch in the browser
task; ask drafted at
`platform-asks/browser-task-script-execution.md`, not filed).

Disposition:
- Writes across all 15 waves are PARKED pending Braden's Mac-rig-vs-defer
  decision. Do not re-render write briefs for the browser task; they cannot
  execute.
- The reads track proceeds: `gets-only/` holds 14 self-contained GET-only
  briefs (waves 2-15, 119 pending GET ops, 127 steps) plus GET-WAVES-README.md.
  Wave 1's GETs are already proven tonight and are not re-run.
- The browser task's own suggestion (have the parent relay the token value
  through a "protected lookup") was declined: credential material never
  transits agent context, per standing credential rules.
- GET ops that cannot run without a prior write are excluded with reasons
  in GET-WAVES-README.md; they rejoin the battery if a write lane unblocks.
