# API catalog guide: the two catalogs and what each covers

Morrow for Muse works with two catalogs. This file maps them, because
mixing them up is the fastest way to claim something that is not true.

## Catalog A: the desktop research catalog (NOT dispatchable)

Historical provenance: `origin-morrow/` is the desktop Morrow monorepo,
not shipped in this package. `origin-morrow/packages/canvas-api-catalog/`
is a TypeScript package
(`@morrow/canvas-api-catalog@1.0.0`, 4681 lines across 6 modules) that
documents Canvas's official API surface. Its generated artifact
(`artifacts/canvas-api/canvas-api-catalog.json`, from the 2026-09-20/21
fix-campaign worktree; historical provenance, not shipped in this package)
holds **1137 operations**: 1118 from the Canvas official Swagger 1.2
(144 resources, last modified 2026-09-11), 571 reads, 566 writes.
The documentation categories sometimes cited alongside it (32 New
Quizzes operations, 18 Item Bank operations, 19 browser-session
operations, 1 course-file-content operation) describe harvest
groupings, not additional operations: adding them to 1118 would
double-count. Every
operation carries a risk class (`read` / `write` / `sensitive_write` /
`destructive`), a source digest, and a full parameter schema.

The TS modules are admission machinery, not a dispatch list:

- `operation-admission.ts`: course-target scoping, multi-context
  refusal, learner-scope route detection, upload-listing reads, and
  readback assessment.
- `semantic-target.ts`: resolving the exact course target for an
  operation; resolutions older than 60 seconds are stale.
- `readback-plan.ts`: building and evaluating browser readback plans
  (frozen before/after assertions, recovery descriptors).
- `entity-read-routes.ts`: the declared readback GET for a given
  write tool (e.g. which member GET proves an assignment create).
- `classic-quiz-question-contract.ts`: the classic-quiz question
  payload contract and its supported question types.
- `index.ts`: the catalog interface (risk, parameters, digest).

The desktop catalog records paths WITHOUT the `/api` prefix (e.g.
`/v1/courses/{course_id}/assignments`); the for-muse catalog adds
the real `/api` prefix. Do not mix path conventions when dispatching.

**Important:** Catalog A documents what Canvas's API offers. It is
provenance for what CAN exist, not proof of what Morrow can do.
Only Catalog B dispatches.

## Catalog B: the for-muse dispatch catalog (dispatchable)

`proof-battery/OPERATION_CATALOG.md` holds **457 rows** that ARE
dispatchable through `dispatch/executor.py --backend chromium`:
437 Canvas rows (C-1 through C-437) and 20 Item Bank rows (IB-1
through IB-20). Each row names a tool, method, path template,
read/write class, mechanism, proof status, and evidence notes. Only
rows marked `live-proven` dispatch; a row marked `pending` also runs
with an educator-signed `--allow-unproven` override, and rows marked
`failed`, `unsupported`, or `excluded` never run. The admission policy
(`dispatch/admission_policy.json`) can hold even a live-proven row;
its `evidence_holds` list names each held row and why. Its
`admitted_on_proof` list records the rows a live battery released
through the whole product pipeline, such as New Quiz create (C-286)
on 2026-09-22.

Status counts, Canvas rows: live-proven 195, pending 210, failed 12,
unsupported 11, excluded 8, evidence-hold 1. Item Bank rows:
live-proven 14, pending 2, failed 0, evidence-hold 4.

Of the 209 live-proven rows, 115 are reads and 94 are writes (110 of
the reads are Canvas rows, 5 are Item Bank bank-level reads).

## Coverage by area (what is actually live-proven)

Courses: get, update (rename, readback-verified and restored),
settings, tabs, sections reads. Course create never tested. Course
conclude/delete is evidence-hold (`canvas_delete_conclude_course`,
policy-held); destructive, admission ceremony required, no v1 claim.

Enrollments: all pending (C-168 through C-174), learner-data gated.
There is no enrollment write or read the agent may touch until the
tokenization boundary lands.

Assignments: create/read/update/delete, overrides
(create/read/update/delete, batch create/update, bulk date update),
and assignment groups CRUD. Delete proven with terminal GET 404.
Assignment duplicate (`canvas_duplicate_assignment`) is live-proven;
the desktop contract notes its readback binds `original_assignment_id`
(see `knowledge/new-quizzes-contract.md` for the New Quiz duplicate
caveat).

Quizzes (classic): CRUD, question groups CRUD plus reorder, questions
CRUD. Delete receipt is index removal: a direct member GET may still
serve the deleted quiz (D-002, provider soft-delete).

New Quiz: object create, update, and delete (C-286, C-299,
C-289) are proven through the full governed product pipeline
(2026-09-22, disposable quizzes 4049059 and 4049060) and ship in v1
(SCOPE.md). Question items (C-287 create, C-293 read, C-295 list,
C-298 update, C-290 delete) are proven through the same pipeline
(items 11057310, 11057311) and ship too. Publish never tested. The in-place item edit hazard
(ghost-stub choices) and the quiz_settings merge rule are documented
in `knowledge/new-quizzes-contract.md`; they are
**NOT IMPLEMENTED** in the for-muse executor, so a New Quiz item
edit through this package has no merge safety. Say so to the
educator before offering one.

Item Banks: bank-level only (create, rename, share, unshare,
archive, list, list entries, get entry, list shares). Item
create/read/update/delete
(IB-6/IB-11/IB-18/IB-19) are implemented in the SDK lane but pending
live proof: do not dispatch against real items, do not claim them.
quiz_entries routes (IB-2/IB-3/IB-8/IB-14) are evidence-hold (401,
wrong scope). Full mechanism: `knowledge/item-banks-sdk.md`.

Outcomes: 7 live-proven reads (outcome groups/links in context).
Outcome alignment writes for New Quiz items are unsupported by the
Canvas contract; no write tool exists. Link/unlink outcome are absent.

Modules: create/read/update/delete plus module items
create/update, live-proven. Module-item delete (C-271) is catalog
pending, not a v1 claim.

Pages: create/read/update/delete/duplicate/revert, live-proven.
Front-page management excluded (C-333: PUT 200 with no state change).

Files: reads live-proven (list files, list folders, get file/folder,
usage rights, upload URL). File upload is live-proven (C-130,
`canvas_upload_file_v1_courses_course_id_files_post`, 2026-09-21
Chromium write battery); the desktop catalog's reviewed-upload
contract (CanvasReviewedUploadRoute) is NOT ported: **NOT
IMPLEMENTED** in for-muse. Do not invent an upload flow beyond the
live-proven recipe.

Discussions: reads pending (C-144 through C-151 are all pending,
learner-data gated). Writes (C-139 create, C-141 delete, C-167
update) carry live-proven marks from the retired canvas-batch form
lane on 2026-09-20; C-238 (discussion date_details PUT 204) was
proven through the 2026-09-21 Chromium write battery, not the form
lane. SCOPE.md withholds all discussion writes from v1, and the
admission policy holds all four (`evidence_holds`): dispatch refuses
them on every lane. Announcements are never posted: any request that
sets `is_announcement`, on any route, and creating an announcement
external feed (C-25) are never-dispatch (posting an announcement
notifies every student in the course; a standing product
exclusion).

Grades/submissions/gradebook: no live-proven grades or submissions
rows (all pending or excluded). Learner-data gated. The admission
gate refuses them on every tenant; `--allow-unproven` cannot override
this. See `knowledge/privacy-ferpa.md`.

Moodle: proven in a sandbox, not packaged. **NOT IMPLEMENTED** here.
Blackboard: no implementation exists. **NOT IMPLEMENTED** here (see
`knowledge/blackboard-recovery.md` for the research status).

## NOT IMPLEMENTED in for-muse (do not offer, do not imply)

- Stimulus items (read-only everywhere; New Quizzes API offers no
  stimulus write).
- Quiz-entry PATCH/PUT (Canvas documents none; in-place draw changes
  are absent by design).
- Unshare via DELETE is not a route (404s). The live-proven unshare
  is IB-20: PATCH /api/banks/{bank}/shared_banks/{id} with
  {shared_bank:{permission:"removed_access"}}. Bank archive remains
  the provider's whole-bank delete.
- Tag search/add/remove, outcome link/unlink, bank reorder, item
  reorder, bulk item points, QTI import/export of banks, account-level
  bank administration.
- Anything from the 1137-op desktop catalog not marked live-proven in
  Catalog B.
