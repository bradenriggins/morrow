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
- Course read/update: get course, update course (rename, readback
  verified and restored), course settings, course tabs. Course create was
  never tested. Course delete/conclude (C-108) is on evidence hold and
  is not a v1 claim.
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
  no state change). Setting the front page is not a v1 claim.
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
  400s on report creation; honestly failed).
- Item Banks: bank-level write operations (create, rename, share,
  unshare, archive) are live-proven through the Chromium lane
  (IB-1 archive, IB-5 create, IB-16 rename, IB-17 share, IB-20
  unshare, 2026-09-21 write battery). Bank-level reads (list, list entries,
  get entry, list shares; IB-9/IB-10/IB-12/IB-13/IB-15) are marked
  live-proven in the catalog on the earlier quiz-api-token lane only;
  Chromium-lane read proof is pending, so they are carried as v1
  claims on the catalog marks, not on Chromium-lane evidence. Item
  create/read/update are implemented through the Item Banks SDK lane
  (`transport/item_bank_sdk.py`, ported 2026-09-21 from Meridian
  production's proven recipe: dynamic LTI tool resolution, course-scoped
  launch, CDP Network interception of the banks.build response with the
  token held in memory only, per-tenant quiz-api host derivation, item
  fetches evaluated in the live quiz-lti frame's execution context,
  fields nested under top-level "item"); live proof is pending educator
  sign-in, so they are cataloged as pending, not live-proven. Item delete
  is implemented in the lane but unproven (Meridian has no delete_item
  flow); the live battery attempts it against a disposable item before
  any claim is made.
- 113 verified GETs (2026-09-21; GET/HEAD only, no writes):
  108 Canvas reads plus 5 Item Bank reads, all recorded
  `live-proven` in `proof-battery/OPERATION_CATALOG.md`, across course
  settings, tabs, sections, files and folders, pages, modules,
  assignments, assignment groups, classic quizzes, New Quiz reads,
  grading standards, rubrics, outcomes, external tools and feeds,
  content migrations and exports, groups, users and search, conferences,
  collaborations, media objects, permissions, and activity stream.
- The governance layer that makes it safe: frozen plans, the admission
  gate (`dispatch/admission.py`) enforcing the live-proven catalog,
  educator-signed approvals, per-category never-dispatch lists,
  journaled dispatches, and undo entries for undoable writes. A
  non-live-proven operation dispatches only with `--allow-unproven`
  plus an educator-signed v2 approval carrying `allow_unproven: true`,
  bound to the exact operation and parameters, for that known catalog
  row only. It does not bypass write approval, frozen-plan
  requirements, never-dispatch, unsupported, evidence-hold,
  learner-data refusal, or unknown-operation refusal.
- The Canvas Login Helper (`helper/`): educator self-sign-in,
  SSO/MFA-capable, with keepalive.

### In scope but pending live proof (not shipped v1 claims)

The following are inside the contract's scope but have no live proof
yet, so the skill must not claim or dispatch them until a disposable
live battery marks them live-proven in
`proof-battery/OPERATION_CATALOG.md`:

- Account, user, and global reads (accounts, users, courses, search,
  terms, help links): in scope by the parity rule, but there are
  currently no catalog rows proving them. Dispatch requires educator
  sign-in to confirm.
- Discussion writes (C-139 create, C-141 delete, C-167 update,
  C-238 date_details): catalog live-proven only (C-139/C-141/C-167
  through the retired form lane 2026-09-20; C-238 through the
  2026-09-21 Chromium battery), withheld from v1 claims.
- Item-level Item Bank CRUD (IB-6/IB-11/IB-18/IB-19): implemented in
  the SDK lane (`transport/item_bank_sdk.py`), pending live proof.

## Out for v1

- Moodle. Proven in a sandbox, but not packaged. Not a v1 claim.
- Blackboard. No implementation exists: no auth, no lane, no transport,
  no catalog, no proof. An honestly-disclosed roadmap item, not a v1
  ship criterion.
- Learner-data operations (grades, submissions, student profiles beyond
  the account/user read scope): refused by the admission gate
  (`LearnerDataGated`) until the tokenization boundary is proven. The
  admission gate refuses them on every tenant by default; this is a
  learner-data refusal, not an evidence-hold.
- Discussions: discussion writes are proven but not v1 claims.
  C-139 (create), C-141 (delete), and C-167 (update) are catalog
  live-proven on 2026-09-20 (discussion 1241942 lifecycle) but carry
  the learner-data flag, so the admission gate refuses them by
  default. C-238 (discussion date_details PUT) is live-proven through
  the 2026-09-21 Chromium write battery (PUT 204). No discussion
  reads are among the 113 verified GETs (all discussion reads are
  pending, learner-data gated). Discussion writes are not a v1
  claim.
- Classic question banks: never tested. Not a v1 claim.
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
