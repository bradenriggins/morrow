# v1 capability scope

The Morrow for Muse connector v1 is a Canvas-only connector. This file is the
exact, complete statement of what v1 ships and what it does not. Do not
imply capabilities beyond it.

The standing rule for every bullet below: ships in v1 means the operation
is marked `live-proven` in `proof-battery/OPERATION_CATALOG.md`, proven
live through the Chromium lane (in-page `fetch()` inside the educator's
authenticated Chromium session via CDP on 127.0.0.1:19223). Anything not
marked `live-proven` is not a v1 claim.

## Ships in v1

- The live-proven Canvas Chromium core: every operation dispatches
  through `dispatch/executor.py` with `--backend chromium`, executing as
  in-page `fetch()` inside the educator's own authenticated Chromium
  session via CDP on 127.0.0.1:19223.
- Your own account: list your courses (C-437, the first request an
  educator makes: "Show me my courses") and read your own profile
  (C-436, `/api/v1/users/self`), proven live on 2026-09-22 and
  2026-09-21.
- Course read/update: get course, update course (rename, readback
  verified and restored), course settings, course tabs. Course create was
  never tested. Course delete/conclude (C-108) is on evidence hold and
  is not a v1 claim. The same change sent through a course update is
  refused too: `event` (delete, conclude, claim, offer, undelete) on
  C-128, and `offer`, which publishes the course.
- Assignment create/read/update/delete, proven 2026-09-21 through the
  Chromium lane (assignment 4045385 created with readback verification;
  delete verified with terminal GET 404).
- Module create/read/update/delete plus module items
  (create/update), proven 2026-09-21 (module 958491; module item
  10058160). Module-item delete (C-271, `canvas_delete_module_item`)
  is catalog pending, not a v1 claim.
- Pages: create/read/update/delete/duplicate/revert, proven 2026-09-21.
  Front-page management is excluded: C-333 failed live (PUT returned 200
  but the provider returned the original front page, so readback caught
  no state change). Setting the front page is not a v1 claim, and the
  same effect through a field is refused: `front_page` true on a page
  create or update (C-323, C-334), and `default_view` on a course update
  (C-128).
- Classic quizzes: create/read/update/delete, question groups
  (create/update/delete/reorder), and quiz questions
  (create/update/delete), proven 2026-09-21 (quiz 338345; question
  6797992; group 47372). Provider soft-delete disclosure (D-002): after
  a classic quiz delete, the quiz leaves the course quiz index but the
  provider may still serve the deleted quiz on a direct member GET;
  index removal is the delete receipt.
- New Quizzes: the quiz object lifecycle (create, update, delete)
  through the Chromium lane, proven 2026-09-21 (quizzes 4045401,
  4045406, 4045410, 4045411; update readback-verified; deletes verified
  with terminal GET 404) and 2026-09-22 through the full governed
  product pipeline (admission gate, mode check, journal, page-context
  transport): disposable quizzes 4049059 and 4049060 created, read
  back, updated, and deleted with terminal GET 404 and zero leftovers.
  Question items are proven through the governed pipeline 2026-09-22:
  choice item create (Equivalence scoring, string choice id), entry
  readback, entry-nested title PATCH with interaction-id preservation
  check, reorder via PATCH position, and delete with absence
  verification (items 11057310, 11057311). `canvas_create_new_quiz`
  left evidence-hold on 2026-09-22 (admission_policy.json v1.2.0) after
  the integrated-path battery passed with full cleanup. Explicitly
  excluded: quiz publish (never tested) and quiz reports (provider
  400s on report creation; honestly failed). A publish is refused on
  every route that can make one: `published` true on a New Quiz create
  or update (C-286, C-299), and on the assignment (C-43) or module item
  (C-283) of a New Quiz, which the executor reads first to check.
- Item Banks, through the Item Banks SDK lane (`transport/item_bank_sdk.py`:
  course-scoped banks.build launch, token held in memory only,
  per-tenant quiz-api host). Bank writes (IB-1 archive, IB-4 attach
  entry, IB-5 create, IB-16 rename, IB-17 share, IB-20 unshare) and
  bank reads (IB-9 get bank, IB-10 get entry, IB-12 list banks, IB-13
  list entries, IB-15 list shares) are live-proven through the governed
  executor pipeline (2026-09-22 Lane 6 battery, disposable objects,
  full cleanup), most also in the 2026-09-21 Chromium write battery.
  Item create (IB-6) and item update (IB-18) are live-proven through
  the Chromium SDK lane (2026-09-21; item 11244176 in disposable bank
  4062; update read back through the bank entry). Entry delete (IB-7)
  is live-proven. Not v1 claims: direct item GET (IB-11, the provider
  answers 404 on live items; the bank entry GET is the working item
  read), item delete (IB-19, never proven on any lane), and the quiz
  entry routes (IB-2/IB-3/IB-8/IB-14, evidence-hold).
- 115 live-proven reads (GET/HEAD only, no writes): 110 Canvas reads
  plus 5 Item Bank reads, all recorded `live-proven` in
  `proof-battery/OPERATION_CATALOG.md`, across your courses and your
  own profile, course settings, tabs, sections, files and folders,
  pages, modules, assignments, assignment groups, classic quizzes, New
  Quiz reads, grading standards, rubrics, outcomes, external tools and
  feeds, content migrations and exports, groups, users and search,
  conferences, collaborations, media objects, permissions, and
  activity stream.
  Some of these reads return people, so they are learner data (see
  "Out for v1"): C-78 potential collaborators, C-105/C-106 activity
  stream, C-112 effective due dates, C-274/C-343/C-344 assignment
  overrides, C-327/C-331/C-332 page revisions, C-231/C-234/C-235/C-236
  date details (override student lists), C-403 course search, and
  C-322 outcome alignments for a student. Like every learner-data row,
  they dispatch only on the Chromium lane with the encrypted learner
  vault, de-identified before the agent or the journal sees them
  (fixture-proven, see "Out for v1"); no other lane runs them
  (`LearnerDataGated`). The live-proven override writes (C-34, C-36,
  C-39, C-41, C-51, C-284) and the page revision revert (C-328) follow
  the same rule.
- The governance layer that makes it safe: frozen plans, the admission
  gate (`dispatch/admission.py`) enforcing the live-proven catalog,
  educator-signed approvals, per-category never-dispatch lists, and
  journaled dispatches. This release has no automatic undo: no undo
  entry is pinned, and each approval says the change cannot be undone
  automatically; a reversal is a new change the educator approves. Only
  live-proven operations run, with no exception and no override: rows
  marked `pending`, `failed`, `unsupported`, `excluded`, or
  `evidence-hold`, and unknown operations, are refused even when the
  educator asks and even with a signed approval.
- The Canvas Login Helper (`helper/`): educator self-sign-in,
  SSO/MFA-capable, with keepalive.

### In scope but pending live proof (not shipped v1 claims)

The following are inside the contract's scope but have no live proof
yet, so the skill must not claim or dispatch them until a disposable
live battery marks them live-proven in
`proof-battery/OPERATION_CATALOG.md`:

- Account, other-user, and global reads (listing accounts, another
  person's profile, global search, terms, help links): in scope by the
  parity rule, but there are currently no catalog rows proving them.
  Your own course list and profile are live-proven and ship (see "Ships
  in v1").
- Discussion writes (C-139 create, C-141 delete, C-167 update,
  C-238 date_details): catalog live-proven only (C-139/C-141/C-167
  through the retired form lane 2026-09-20; C-238 through the
  2026-09-21 Chromium battery), withheld from v1 claims. The admission
  policy holds all four (`evidence_holds`), so they are refused on
  every lane until a Chromium-lane battery proves create, update, and
  delete.
- Item Bank item read and delete (IB-11/IB-19): implemented in the SDK
  lane, not proven (see Item Banks above).

## Out for v1

- Moodle. The catalog records a few Moodle operations proven on a
  public Moodle sandbox (sandbox.moodledemo.net, 2026-09-20), such as
  M-9 list my courses and forum discussion create/delete. The executor
  does not dispatch Moodle rows, the Moodle code (`moodle/`) is not in
  the release, and production SSO and session lifetime are unproven.
  No Moodle read or write is a v1 claim. v1 connects to Canvas only.
- Blackboard. No implementation exists: no auth, no lane, no transport,
  no catalog, no proof. An honestly-disclosed roadmap item, not a v1
  ship criterion.
- Learner-data operations: every operation whose response carries
  people (rosters, enrollments, submissions, grades, collaborators,
  activity, per-student dates and overrides, edit history). The
  classification is structural (`dispatch/admission_policy.json`
  `learner_data`) plus the catalog `[LEARNER-DATA]` flag. `executor.py
  catalog` dispatches the `live-proven` ones only on the Chromium lane
  with the encrypted learner vault (the optional `cryptography`
  package), where every receipt is de-identified in `dispatch_entry`
  (course-scoped labels such as `Student A1`) before the agent or the
  journal sees it. Everywhere else (the raw HTTPS lane, or no
  `cryptography`) they are refused (`LearnerDataGated`). The educator
  works by name through `bin/morrow students find` and writes by label (SKILL.md
  "Working by name"). Proof status: the by-name flow and the opened
  people-bearing rows are proven against synthetic Canvas fixtures in
  the source tree's end-to-end tests; they have not yet been exercised
  end to end against a live Canvas
  course with real students, so treat them as fixture-proven, not
  live-proven, until that battery runs.
- Course content de-identification: before a Chromium-lane dispatch
  reads or changes anything in a course, the executor reads the
  course's student roster (every enrollment state, and deleted
  enrollments) and labels every student named in course content (a
  page body, an assignment description), restoring the real text when
  content is saved back (`privacy/course_content.py`). It is a privacy
  control, not a capability, and it is fixture-proven like the by-name
  flow: the roster read (the same Canvas requests the desktop Morrow
  makes) has not yet been run through this lane against a live
  course.
- Discussions: C-139 (create), C-141 (delete), and C-167 (update) are
  catalog live-proven on 2026-09-20 (discussion 1241942 lifecycle)
  through the retired form lane, never the Chromium lane. C-238
  (discussion date_details PUT) is live-proven through the 2026-09-21
  Chromium write battery (PUT 204). The admission policy holds all
  four on every lane (see "In scope but pending live proof"). No
  discussion reads are among the 115 live-proven reads (all discussion
  reads are pending).
- Announcements: never posted, even when the educator asks. Any
  request that sets `is_announcement` (on any route, in the body or
  the query) and creating an announcement external feed (C-25) are
  never-dispatch in the admission policy. Posting an announcement
  notifies every student in the course.
- Messages to people and acting as someone else: never done, even when
  the educator asks. Any request that sets `notify_of_update` (Canvas
  then notifies every student in the course of the change) or
  `as_user_id` (Canvas then acts as that person), on any route, in the
  body or the query, is never-dispatch in the admission policy.
  `notify_of_update` set to false sends nothing and is not refused.
- Classic question banks: never tested. Not a v1 claim. A question
  group that draws from one (`assessment_question_bank_id` on C-347 or
  C-352) is refused.
- The remainder of the 457-row for-muse catalog (437 Canvas rows
  plus 20 Item Bank rows): only rows marked `live-proven` are v1
  claims. (The desktop harvest catalog is a separate 1,137-operation
  artifact; see `knowledge/api-catalog-guide.md`.)
- The form relay. Retired and excluded: no form-relay code ships, no
  relay dependency exists, and the connector never sends data through a
  hosted page.

## Standing rules

- Parity law: no operation is gated or restricted by tenant. An
  operation is admitted on every tenant or on none.
- Browser-owned auth: no password, token, or cookie ever passes through
  the agent. The educator signs in themselves through the helper.
- `CANVAS_BASE` is always educator config. There is no default tenant.
