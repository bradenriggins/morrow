# Operations runbook: what the catalog covers and how to dispatch it

This is the agent-facing map of the Morrow for Muse operation catalog and
the governed dispatch path. The catalog file is the provenance record;
`dispatch/admission.py` with `dispatch/admission_policy.json` is the
enforcement gate. Both must agree before anything dispatches.

## The catalog in one minute

`proof-battery/OPERATION_CATALOG.md` holds 456 rows: 436 Canvas rows
(C-1 through C-436) plus 20 Item Bank quiz-api rows (IB-1 through
IB-20). Each row names a tool, an HTTP method, a path template, a
read/write class, a mechanism, a proof status, and evidence notes.
Current status counts (Canvas rows): live-proven 194, pending 210,
failed 12, unsupported 11, excluded 8, evidence-hold 1. Item Bank rows:
live-proven 13, pending 2, failed 1, evidence-hold 4.

Statuses mean:
- `live-proven`: a disposable live battery proved the operation through
  the browser-owned session with readback verification and full cleanup.
  This is the only status that dispatches without an educator override
  (with one caveat, below).
- `pending`: never proven. Dispatch refuses unless the educator signs
  an explicit `--allow-unproven` override as part of the approval, and
  even that cannot override the absolute refusals below.
- `failed`: a live battery attempted it and it did not work. It is not
  retried without a code or request-shape change. Do not dispatch it.
- `unsupported`: the provider does not serve the route (e.g. AI
  experiences POST 404s). Never dispatch it; the gate refuses it.
- `excluded`: retired or removed paths (e.g. the old quiz-api-token
  lane rows superseded by the Chromium lane). Never dispatch.
- `evidence-hold`: not yet live-proven and refused on EVERY tenant
  until a disposable live battery proves the complete path; when proven
  it is admitted on ALL tenants (parity law, nothing gated by tenant).

## The dispatch rule (the part that bites)

The gate checks the catalog row BEFORE anything else
(`_catalog_provenance_gate` in `dispatch/executor.py`):

1. The `--name` must be a real catalog tool name. An unknown name raises
   `CatalogNotProven` and cannot be overridden by any flag. The name is
   not free text.
2. The `--method` and `--path` you pass must match the row's recorded
   method and path exactly. A proven name paired with arbitrary CLI
   arguments raises `CatalogNotProven`. You cannot smuggle a new request
   shape behind a proven name.
3. The row status must be `live-proven`, or you must pass
   `--allow-unproven` with an educator-signed approval record carrying
   `allow_unproven: true` (sealed by `sign_approval`).

Then the absolute refusals run, and `--allow-unproven` cannot touch
them: `never_dispatch` rows (blueprint, CSP, SIS, conversations,
feature flags, the quiz submission-users message), `unsupported`,
`evidence-hold`, and `learner-data` (URL substrings `/users/`,
`/enrollments`, `/submissions`, `/gradebook`, `/grades`, `/analytics`,
`/ai_conversations`, `/ai_experiences`; `/users/self` excepted).

**Important caveat:** a catalog row marked live-proven can still be
held by the admission policy. Example: `canvas_create_new_quiz` is
live-proven in the catalog at the provider-path level, but
`dispatch/admission_policy.json` holds it on evidence-hold because the
2026-09-21 write battery proved the provider path only and the governed
product pipeline has no live runs yet (the 2026-09-21 gap audit's
finding: executor pipeline proven at the provider path, zero live
runs through the governed pipeline). The catalog is the
provenance record; the policy is the dispatch authority. When they
disagree, the policy wins.

## What is live-proven (v1 working set)

Proven 2026-09-21 through the Chromium lane on course 89585, with
readback and cleanup:

- **Courses**: get course, update course (rename, readback-verified and
  restored), course settings, course tabs. Course create was never
  tested. Course conclude/delete (C-108) is on evidence hold.
- **Assignments**: create/read/update/delete, plus overrides
  (create/read/update/delete, batch override create/update, bulk date
  update) and assignment groups CRUD. Create proven with HTTP 201 and
  readback name match; delete proven with terminal GET 404.
- **Modules**: create/read/update/delete plus module items
  create/update. Module-item delete (C-271) is catalog pending, not
  a v1 claim.
- **Pages**: create/read/update/delete/duplicate/revert. Front-page
  management is excluded (C-333: PUT 200 but the provider kept the
  original front page; readback caught no state change).
- **Classic quizzes**: CRUD, question groups CRUD plus reorder, quiz
  questions CRUD. Provider soft-delete disclosure (D-002): after a
  delete, the quiz leaves the course quiz index but a direct member GET
  may still serve it. Index removal is the delete receipt.
- **New Quizzes**: update/delete of the quiz object through the
  Chromium lane (quizzes 4045401, 4045406, 4045410, 4045411; update
  readback-verified; deletes verified with terminal GET 404).
  **Admission still holds `canvas_create_new_quiz` on evidence-hold:**
  the 2026-09-21 battery proved the provider path only and the governed
  product pipeline has no live runs yet, so dispatch refuses it on
  every tenant until a disposable live battery proves the integrated
  path (D-007; the governed product pipeline has no live runs yet, so
  it stays held until a disposable live battery proves the integrated
  path). Excluded: publish (never tested). Question
  items (catalog C-287/C-290/C-293/C-295/C-298): the gate currently
  admits them as live-proven, but SCOPE.md withholds them from the v1
  claim set (proven at the provider-path level only); treat them as
  not-a-v1-claim and disclose that before touching them.
- **Item Banks**: bank-level operations only (IB-1 archive, IB-5
  create, IB-9 get, IB-12 list, IB-13 list entries, IB-10 get entry,
  IB-15 list shares, IB-16 rename, IB-17 share, IB-20 unshare). Item create/read/update
  (IB-6/IB-11/IB-18) are implemented in the Item Banks SDK lane but
  live proof is pending, so they are cataloged as pending. Item delete
  (IB-19) is implemented and unproven; the live battery attempts it
  against a disposable item before any claim. quiz_entries routes
  (IB-2/3/8/14) are evidence-hold (401 under the banks.build scope).
  Full mechanism: `knowledge/item-banks-sdk.md`.
- **Reads**: 113 verified GETs (108 Canvas plus 5 Item Bank) across
  course settings, tabs, sections, files and folders, pages, modules,
  assignments, assignment groups, classic quizzes, New Quiz reads,
  grading standards, rubrics, outcomes, external tools and feeds,
  content migrations and exports, groups, users and search,
  conferences, collaborations, media objects, permissions, and
  activity stream, plus account/user/global reads. All recorded
  `live-proven` in the catalog.
  Discussions: reads pending (C-144 through C-151, learner-data
  gated); plain discussion-topic writes (C-139 create, C-141 delete,
  C-167 update) are catalog live-proven BUT were proven through the
  retired canvas-batch form lane on 2026-09-20, not the Chromium lane,
  while C-238 (discussion date_details, PUT 204) was proven through
  the 2026-09-21 Chromium write battery. SCOPE.md withholds all
  discussion writes from v1. Treat them as proven-mechanism-mixed:
  disclose the lane before touching them.
  Announcement variants stay excluded (posting an announcement
  notifies enrolled users; a standing product exclusion).

Not v1 claims at all: Moodle (proven in a sandbox, not packaged),
Blackboard (no implementation exists), learner-data operations
(refused by the admission gate as learner-data until the tokenization
boundary is proven), the form relay (retired and excluded), classic
question banks (never tested), and the remainder of the 457-row
for-muse catalog.

## Live-proven write recipes (request shape, readback, delete rule)

For each write family below, the recipe is four parts: the request
shape that worked live, the member or list readback that proves it,
the delete absence rule where one exists, and the provider-specific
caveat. A green status code is never the receipt. The executor's
post-write readback runs automatically on six surfaces and raises
`WriteFieldMismatch` on mismatch; your job is to read the receipt
and confirm the fields anyway.

- **Courses** (C-128, C-129). Shape: PUT `/api/v1/courses/{id}`
  (body `{"course": {...}}`) or PUT
  `/api/v1/courses/{course_id}/settings` (flat). Readback: member
  GET `/api/v1/courses/{id}`, compare the changed fields. Caveat:
  the rename battery restored the original name after the test write;
  course create was never tested; course conclude/delete (C-108) is
  evidence-hold and refuses on every tenant.
- **Assignments** (C-38 create, C-43 update, C-40 delete, C-42
  duplicate; overrides C-39/C-41/C-51, batch C-34/C-36/C-37, groups
  C-29/C-30/C-31). Shape: POST `/api/v1/courses/{course_id}/
  assignments` (body `{"assignment": {"name": ...}}`); update is PUT
  to `/api/v1/courses/{course_id}/assignments/{id}`; duplicate is
  POST `.../assignments/{assignment_id}/duplicate`. Readback:
  member GET `/api/v1/courses/{course_id}/assignments/{id}`, name
  match (executor post-write readback, D-009). Delete: follow-up
  member GET expecting 404 (the D-005 rule: 404-after-delete counts
  as success ONLY with that follow-up GET). Caveats: changing
  `points_possible` rescales every score already entered, disclose
  it in the approval; changing `due_at` does NOT move existing
  overrides (separate read).
- **Modules** (C-268 create, C-282 update, C-270 delete; items C-269
  create, C-283 update; C-276/C-277/C-278/C-284 progress/overrides).
  Shape: POST `/api/v1/courses/{course_id}/modules` (body
  `{"module": {"name": ...}}`); item create is POST
  `.../modules/{module_id}/items` with the item type field set.
  Readback: member GET of the module and the item, position and
  type confirmed. Delete absence rule: none for module items yet;
  module-item delete (C-271) is catalog pending and not a v1 claim.
- **Pages** (C-323 create, C-334 update, C-324 delete, C-325
  duplicate, C-328 revert). Shape: PUT goes to
  `/pages/{url}`, not `/pages/{id}`; create body
  `{"wiki_page": {"title": ..., "body": ...}}`. Readback: member GET
  by page URL, title and body match; the executor pre-GETs the URL
  before a PUT (D-011: a PUT to a nonexistent URL silently creates
  a page). Delete: follow-up GET expecting 404. Caveat: front-page
  management is excluded (C-333 failed live: PUT 200 but the
  provider kept the original front page).
- **Classic quizzes** (C-374 create, C-376 update, C-375 delete;
  question groups C-347/C-352/C-348 plus reorder C-351; questions
  C-353/C-354/C-357). Readback: member GET of the quiz, question,
  or group. Delete: removal from the course quiz index is the
  receipt (D-002: a direct member GET may still serve a deleted
  quiz, so 404 is not the receipt here).
- **New Quiz** (C-299 update, C-289 delete; items C-287/C-290/
  C-298/C-293/C-295). Shape: PATCH only on `/api/quiz/v1` paths;
  the executor guards this (no PUT). Item fields nest under
  `item.entry`. Readback: NQ GET, items GET with the expected
  count, points mirror (parent `points_possible` equals the item
  sum), parent assignment dates/overrides read. Caveats: create
  (`canvas_create_new_quiz`) is evidence-held by the admission
  policy and refuses on every tenant; the `quiz_settings` merge
  rule is NOT IMPLEMENTED in this package (a partial PATCH can
  replace the whole settings block: read, merge locally, then
  PATCH); ghost-stub choice hazards are in
  `knowledge/new-quizzes-contract.md`.
- **Discussions** (C-139/C-141/C-167 form-lane retired; C-238
  date_details PUT 204). Withheld from v1. Shape: flat params
  (`{"title": ..., "message": ...}`, NOT a `discussion_topic`
  wrapper; only the `assignment` subobject nests for graded
  discussions). The executor unwraps one nesting level for readback
  comparison and prevalidation but sends the body unchanged, so a
  wrapped body still hits the D-009 failure class. Disclose the
  lane before touching any discussion write.
- **Files** (C-130 upload, C-191 folder create, C-200/C-203 usage
  rights). Shape: POST `/api/v1/courses/{course_id}/files`. The
  provider upload is a multi-step flow; the recipe is the live
  battery's, not an invented one. Readback: member GET of the file
  id, name and size match. The desktop reviewed-upload contract
  (CanvasReviewedUploadRoute) is NOT ported; do not invent an
  upload flow beyond the live-proven recipe.
- **Item Bank bank-level** (IB-5 create, IB-16 rename, IB-17 share,
  IB-20 unshare, IB-1 archive). Shape: POST `/api/banks`
  (create); PATCH `/api/banks/{bank_id}` (rename); POST
  `/api/banks/{bank_id}/shared_banks` (share); unshare is PATCH
  `/api/banks/{bank_id}/shared_banks/{shared_bank_id}` with
  `{"shared_bank": {"permission": "removed_access"}}` (IB-20; there
  is no DELETE route for shares). Readback: per-op snapshot rules
  in `knowledge/item-banks-sdk.md` (before/after list banks, list
  shares). Archive caveat: no account-wide reverse lookup exists,
  so the ceremony presents the fresh bank read (title, entries,
  shares) to the educator with explicit approval on the fan-out;
  disposable-only in batteries. Item delete (IB-19) is pending.
- **Rubrics** (C-383/C-384/C-387/C-394/C-395). Caveat: replacing a
  rubric's criteria rescales every score already entered against
  it; check attachment to a graded assignment and disclose the
  rescale in the approval like any points change.

Verification doctrine: perform the readback from fresh provider
reads after the write; a journal row without a matching provider
readback is not a completed write. If the journal row says
`uncertain: true`, the effect state is unknown: never re-fire the
write to "check", report it as uncertain with the op id, and let
the educator decide. Every disposable test object follows create,
readback-verify, delete, verify-gone.

## Doc map: what to read, what to skip

Agent-facing (read these): `SKILL.md` (this file's parent),
`INSTALL.md`, `SCOPE.md`, the `knowledge/` files, the Status column of
`proof-battery/OPERATION_CATALOG.md`, and `defects/DEFECTS.md` (open
defects D-002 and D-005 affect delete receipts and Item Banks; D-003
and D-004 were closed as moot 2026-09-21 when the relay/form lanes were
retired; D-006 is superseded by the SDK lane).

Investigation notes (not agent-facing, do not ship to agents):
`weasel-b1-runtime-browser.md`, `weasel-b2-canvas-auth.md`,
`weasel-b3-lti-tokens.md`, `weasel-options-sweep.md`, and the
`proof-battery/waves/`, `proof-battery/editor-transport/`,
`proof-battery/js-execution-gate/`, `proof-battery/localhost-proof/`,
and `proof-battery/data-url-diagnostic/` drafts. They record how
proofs were run, not what agents should do. The approval ceremony
behavior is implemented in `dispatch/admission.py` (v2 HMAC-sealed
records, single-use digests, educator signing); the educator-facing
UX wiring is open.

## Dispatching

Reads need no approval (except learner-data reads, which the admission
gate refuses on every tenant regardless). Example (tool name must be a
real catalog row):

```
PYTHONDONTWRITEBYTECODE=1 python3 dispatch/executor.py catalog \
  --name canvas_get_single_assignment --method GET \
  --path /api/v1/courses/{course_id}/assignments/{id} \
  --class read --backend chromium --canvas-base "$CANVAS_BASE" \
  --params '{"course_id": 12345, "id": 67890}'
```

`--params` is a JSON object that fills the `{slots}` in the path
template. Through the CLI it fills path slots only; there is no CLI
flag for query args like `per_page`. To send a body or query block,
dispatch programmatically through `dispatch_catalog_op(...)` in
`dispatch/executor.py` with `extra={"body": {...}}` or
`extra={"query": {...}}`, or dispatch
a manifest entry with `execute --entry <manifest.json> --params '{...}'`.

Writes need three things or they are refused:

1. A frozen plan file (`--plan`), digest-bound to the exact action.
2. An educator-signed approval record (`--approval`), digest-bound to
   the exact action, unexpired, category-scoped, and unused. Mint with
   `dispatch/admission.py` (`mint_approval` / `sign_approval`). The
   educator approves the exact action in their own words before it runs.
   For a course-scoped write the record MUST carry a `target` block
   naming the tenant, course ID, and course name (term when known):
   dispatch verifies the provider's course against it before sending
   anything, and refuses when they disagree (W4-P0-11).
3. No write halt: if `~/.morrow/write_halt` exists, all writes refuse.

The approval burns only after the target-identity check, the
before-state freshness check, and all local request prevalidation
pass, immediately before the first provider call. A refusal at any of
those gates leaves the approval unconsumed and reusable, and the
op_id claim is released (W4 approval ordering).

`undo` runs an entry's undo block as a new, separately journaled
operation (it needs its own educator approval bound to the undo action).

Every dispatch journals to `~/.morrow/trees/<tree-id>/journal/ops.jsonl`
(or `$MORROW_TREE_STATE_DIR/journal/ops.jsonl` when overridden; the
legacy `~/.morrow/journal/ops.jsonl` is read for historical idempotency
only). A normal dispatch journals at least a claim record and a
completion record; failures can journal claim plus release or claim
plus audit. Consumed op ids are never reused. Session death after a
claim journals a claim record plus a journaled release under the
caller's op id, and the op id stays reusable; the approval was consumed
before the network call, so a retry needs a freshly signed approval
AND the educator re-signing in through the login helper.

**Backend rule:** the only permitted `--backend` is `chromium`.
`dispatch/executor.py` has other backends (the catalog names
executor-plain), and the plain HTTPS lane works with a PAT. Never
use them: the standing rule is Chromium-only, no-PAT auth through
the educator's browser session. A "faster" backend that asks you for
a token, cookie, or PAT is a refusal, not a shortcut.

**Approval rule:** never mint or sign an approval yourself. Approvals
are educator-signed through `dispatch/admission.py` (the educator
states the exact action in their own words); your job is to present
the exact action in plain language and hand them the record to sign.
A self-minted approval is a ceremony violation: stop and report it.

Destructive operations that are evidence-held (course
conclude/delete, anything on the policy's evidence-hold list) are
refused on every tenant: no approval, frozen plan, or ceremony admits
them today. Bank archive (IB-1) is admitted and requires the full
admission ceremony: frozen plan plus educator-signed approval plus no
write halt, and disposable test objects with full lifecycle cleanup.
