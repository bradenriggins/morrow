# New Quizzes and Item Banks contract for Morrow for Muse

Historical source (not shipped in this package): `origin-morrow/docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md`
(Meridian production harvest) and `CANVAS-NEW-QUIZZES-COMPLETION-MATRIX-2026-09-08.md`
(8 Sep audit, revised with the New Quizzes gap-closing pass). Status
labels below are for-muse statuses: every desktop "Admitted,
live-unverified" claim has been re-checked against
`proof-battery/OPERATION_CATALOG.md`. Where this package proves less,
the row says so explicitly.

## The three surfaces (do not mix them)

1. Classic Canvas REST (`/api/v1/...`, same Canvas session cookie):
   the linked assignment record (name, grading type, due dates,
   points, publication). A New Quiz IS an assignment with
   `submission_types = ["external_tool"]` and
   `is_quiz_lti_assignment = true`. The New Quiz id is its assignment
   id.
2. New Quizzes (`/api/quiz/v1/...`, same cookie): the quiz record,
   its `quiz_settings`, and directly attached items. All bodies are
   JSON. Calling `/api/v1/.../quizzes/{id}` with a New Quiz id
   returns 404. The stale routes
   `/api/quiz/v1/{accounts,courses}/.../item_banks` 404 and must not
   be used.
3. Item Banks (private `/api/banks/...` on the tenant quiz-api host,
   authorized by an LTI-provisioned `banks.build` token as
   `Authorization: <token>` with `AuthType: Signature`): banks, bank
   entries, bank items, bank shares.

**NOT IMPLEMENTED in for-muse:** the desktop harvest's frozen-plan
planners (`morrow_plan_new_quiz_create`, `morrow_plan_new_quiz_item_create`,
etc.), snapshot digests, the quiz_settings merge tool, the Hot Spot
media-upload chain, and the bank-draw recovery descriptors. Do not
promise them.

## New Quiz lifecycle (for-muse status)

- Create quiz (`POST /api/quiz/v1/courses/{course_id}/quizzes`,
  body `{"quiz": {"title", ...}}`; title required): live-proven at
  the provider path through the Chromium lane (quizzes 4045401,
  4045406, 4045410, 4045411). **BUT the admission policy holds
  `canvas_create_new_quiz` on evidence-hold** because the governed
  product pipeline has no live runs yet. Dispatch refuses it on every
  tenant. Do not offer New Quiz creation until a disposable live
  battery proves the integrated path.
- Read quiz / list quizzes: live-proven reads.
- Update: PATCH only (no PUT on New Quiz paths; the executor guards
  this). **quiz_settings merge rule (IMPLEMENTED as explicit helpers,
  not automatic):** a partial PATCH can replace the whole settings block
  instead of merging, so the safe sequence is read the current block,
  merge locally, send the complete block. `plan_new_quiz_settings`
  performs the read-then-merge (refusing on a missing or unreadable saved
  block, and translating `None` into the saved form Canvas uses for a
  cleared setting), `new_quiz_settings_request` builds the complete-block
  PATCH, and the write readback verifies the echoed `quiz_settings`
  block with cleared-equivalence. You must call these explicitly in your
  planning; dispatch does not run the merge for you. Editing
  quiz_settings through a partial PATCH without reading first risks
  wiping settings the educator set. Disclose before offering.
- Delete quiz: live-proven through the Chromium lane; always delete
  through the quiz API, never through the Canvas assignment endpoint
  (deleting the assignment first left orphan quiz 506477).
- Duplicate: `canvas_duplicate_assignment` is live-proven. The
  desktop contract holds the derived readback caveat: Canvas
  documents no field naming the copy a New Quiz and no signal that
  the copy finished; bind with `original_assignment_id` and verify
  the finished state before claiming success.
- Publish/unpublish: through the linked assignment edit
  (`assignment[published]`). Publish never tested; unpublish can be
  refused by the provider after attempts.

## New Quiz items: the ghost-stub hazard

**NOT IMPLEMENTED in for-muse.** New Quizzes merges `interaction_data`
sub-elements **by id**. An in-place PATCH that regenerates choice,
question, or blank ids does not replace the old elements: it orphans
them into blank "ghost stub" choices, observed in production (one item
ended with 10 real choices and 18 blank ones). The desktop harvest
rules: structural change = delete the item and add the replacement
(not atomic; if the add fails the quiz has one fewer item); in-place
PATCH is safe only when every existing id is preserved and only
non-structural values change. The id-membership check IS implemented
here (`collect_interaction_ids` plus `check_interaction_ids_preserved`,
both unit-tested): you must run it explicitly before any item PATCH,
and plan delete-plus-create on any add-plus-remove rename. The
provider-side merge behavior itself is unchanged, so the warning
stands: warn about ghost stubs before any item edit.

Stimulus is read-only, full stop. The New Quiz Items API says stimulus
items "can only be retrieved with the API. They must be created and
updated via the UI." No write tool exists. Bank-item rows in a quiz
(`Bank` draws, `BankEntry` rows) likewise cannot be created or updated
through the item API; they go through the builder quiz_entries routes,
which are **evidence-hold** in this package (IB-2/IB-3/IB-8/IB-14:
401 under the banks.build scope).

A quiz-entry has no PATCH/PUT. Changing a draw in place is absent by
design: remove the row and add the wanted one as two separately
reviewed changes. New Quiz delete requires no student work (the
desktop planner demands `has_submitted_submissions=false` and
`graded_submissions_exist=false`; this package has no such gate, and
submission reads are learner data, which dispatch only on the
Chromium lane with the encrypted vault and come back de-identified,
and only for live-proven rows), so **ask the educator whether
submissions exist and disclose that the delete is irreversible before
offering it**).

## The /api/quiz/v1 401 trap: LTI provisioning, not the token

Three distinct 401 flavors exist on this package's surfaces (the
other two are in `api-patterns-and-errors.md`). The third is specific
to New Quizzes: `/api/quiz/v1/...` returns 401 while classic
`/api/v1/...` calls on the same session succeed.

That is not session death and not a bad token. The New Quizzes
service provisions the user on their first-ever LTI launch of a New
Quiz; until that has happened, the service does not recognize them
and every `/api/quiz/v1/` call 401s. Re-signing in does not fix it;
a fresh session does not fix it; only the educator opening any New
Quiz once in a real browser fixes it.

Diagnostic order on an NQ 401:
1. Does the classic surface still work on this session? If yes, the
   session is alive; do NOT run dead-session recovery.
2. Ask the educator (or check known state): have they ever opened a
   New Quiz in this tenant? If not, they open one, any one, once.
3. Retry the NQ call. If it still 401s after a live session and a
   known launch, that is an account/provisioning issue to surface to
   the educator, not a token to rotate.

Do not route around it with Classic quiz paths. `/api/v1/.../quizzes`
on a New Quiz id returns 404 or a misleading partial Classic-style
record; it is the wrong product.

## Safe read order when diagnosing a quiz

When something is wrong with a New Quiz, read in this order. The
order exists to kill one specific false positive: the parent
assignment exists, so the agent reports success, but the quiz is
empty or the bank was never attached.

1. The course exists and is the course the educator meant.
2. The parent assignment exists and is a New Quiz
   (`is_quiz_lti_assignment = true`; if `submission_types` includes
   `online_quiz` instead, it is a Classic Quiz and the NQ surface does
   not apply).
3. The New Quiz object exists at
   `/api/quiz/v1/courses/{course_id}/quizzes/{assignment_id}`.
4. The items list exists and has the expected count (never trust the
   shell's existence as proof of items).
5. If a true bank was requested, the bank exists through the SDK lane
   (`/api/banks` on the quiz-api host) and its entries attach to the
   expected bank items.
6. The module item points to the parent assignment, if module
   placement was requested.
7. Module requirements, prerequisites, due dates, overrides, and
   publish state match the educator's intent.

Points check at every read: the parent Assignment's `points_possible`
must equal the sum of item `points_possible` (the mirror rule). Due
dates, availability windows, and overrides live on the parent
Assignment, never on the NQ object: read them there, set them there.
The NQ object reflects the parent's `due_at` for display but is not
the canonical source.

## Question-item shape doctrine (PROVEN 2026-09-22: items are a v1 claim)

Production doctrine for the shape of choice-bearing and matching
items, ported so it is not lost. Item creation and in-place item
updates are implemented and live-proven through the governed product
pipeline on 2026-09-22 (lane-7 battery: choice create with
Equivalence scoring and a string choice id, entry readback, entry-
nested title PATCH, reorder via PATCH position, delete with absence
verification). The id-preservation guard
(`check_interaction_ids_preserved`) refuses ANY membership change on
in-place PATCH (add, remove, or rename); structural changes must be
planned as delete plus create. Use this as the acceptance criteria
against which item writes are verified:

- Nested leaf text (inside choices, matching terms, categories,
  distractors, ordering choices) must be plain text, not HTML. Literal
  `<p>...</p>` in leaf bodies is a shape defect.
- Matching items use the canonical `interaction_type_slug: "matching"`
  and must include `scoring_data.edit_data.matches`, with each
  `question_id` in matches referencing a real question in the item.
  An item that reads back as `multi-answer` when it should be
  matching is a shape defect.
- Matching-item question/answer ids must be string ids of the
  `q-1..q-N` form, never UUIDs. A UUID-shaped id is a later ghost-stub
  merge waiting to happen.
- Replace, don't mutate, for matching too: in-place regeneration of
  question/answer ids can orphan stale sub-elements into ghost stubs
  or malformed matches, the same merge-by-id mechanism as choice
  items. The correct flow is delete the malformed item (or remove the
  bank entry), add a fresh item with a clean payload, read back and
  verify the readback shows zero shape problems before claiming the
  fix.
- Item readback shape checks: `entry_type == "Item"` for inline quiz
  items; `points_possible` numeric and non-negative; top-level prompt
  body valid HTML; leaf bodies plain text; `interaction_type_slug`
  canonical; `scoring_algorithm` compatible with the slug;
  `scoring_data.value` exists; every id in `scoring_data.value`
  exists in `interaction_data`.
- Proven choice shape (2026-09-22, provider-verified): choice items
  use `scoring_algorithm: "Equivalence"` with
  `scoring_data.value` as the correct choice's id STRING
  (e.g. `"lane7-a"`). An array value 422s under Equivalence
  ("did not match ... string, boolean"); AllOrNothing wants an array
  or null. Essay items require `scoring_data` present with
  `value: null`; omitting `scoring_data` 422s ("can't be blank").
- Item titles live under `entry.title` on readback; there is no
  top-level title key. New Quiz items have no `/reorder` endpoint;
  reorder via PATCH `{"item": {"position": N}}`.

The copy caveat: a New Quiz copied into another course can arrive as
an empty template shell (settings, no items; a known Canvas defect).
After any quiz copy or module copy, verify the destination item
count against the source before reporting the copy complete. And
strip literal answer-letter prefixes (`A. `, `B. `, `C. `, `D. `)
from option text: Canvas shuffles answers, and the letters do not
move with them.

## UI-only settings: not in the REST readback

Some New Quizzes delivery toggles are not represented in the
`/api/quiz/v1` `quiz_settings` object (known examples: Detect
Multiple Sessions, Allow clearing selection on multiple choice).
A REST readback that matches your intent does not cover those
toggles. If the educator's request names them, do not stop at the
REST response: disclose that they are UI-only and verify them the
way the educator would, through the helper's browser. Never claim
"all settings verified" on REST evidence alone when the request
named a UI-only toggle.

## Item Banks (for-muse status)

Bank-level operations (IB-1 archive, IB-5 create, IB-9 get, IB-12
list, IB-13 list entries, IB-10 get entry, IB-15 list shares, IB-16
rename, IB-17 share) are live-proven through the Chromium lane via
the Item Banks SDK (`transport/item_bank_sdk.py`). Full mechanism:
`knowledge/item-banks-sdk.md`.

Contract rules that still bind you (from the harvest, enforced by the
SDK lane or not at all):

- Item fields nest under top-level `"item"` (opposite of New Quiz
  items, which nest under `item.entry`).
- Item update is PATCH, never PUT.
- The working item read path is the entry GET (IB-10); direct item
  GET 404s on existing items (provider anomaly).
- Bank create is two phases: `POST /api/banks/{bank_id}/items`
  creates the item object but does NOT put it in the bank; a
  separate `POST .../bank_entries` attaches it. A bank_entries
  readback right after phase one cannot confirm the create.
- An entry row's `id` (the row id) is NOT the item id: deleting an
  entry uses the row id; reading/updating an item uses the item id.
- Item delete (IB-19): the lane implements the route but no
  delete_item flow was ever proven (Meridian has no delete_item
  flow). **PENDING: never dispatch against a real item.**
- Item create (IB-6) and update (IB-18): implemented, pending live
  proof. Entry GET (IB-10) is the proven read path meanwhile.
- Unshare (bank shares): no unshare via DELETE (404s). Unshare is
  PATCH /api/banks/{bank}/shared_banks/{id} with
  {shared_bank:{permission:"removed_access"}} (proven 2026-09-21,
  share 38934; list verified clean). Archive is the whole-bank delete
  (provider's, irreversible).
- quiz_entries routes (IB-2/IB-3/IB-8/IB-14): evidence-hold, 401
  under banks.build. Do not retry.

The fan-out record, observed-reach disclosure, snapshot digests,
per-write verification table, and one-hour record expiry from the
harvest are **NOT IMPLEMENTED** in this package. The operational
equivalent here is: disclose to the educator that a bank is shared
machinery reaching every quiz and course that draws from it (Canvas
exposes no account-wide reverse lookup), get their explicit approval
on that basis through the normal admission ceremony, and verify with
a fresh readback.

## Authoritative provider sources

- New Quizzes: https://developerdocs.instructure.com/services/canvas/resources/new_quizzes
- New Quiz Items: https://developerdocs.instructure.com/services/canvas/resources/new_quiz_items
- New Quizzes Accommodations: https://developerdocs.instructure.com/services/canvas/resources/new_quizzes_accommodations
- New Quizzes Reports: https://developerdocs.instructure.com/services/canvas/resources/new_quizzes_reports
- Assignments: https://developerdocs.instructure.com/services/canvas/resources/assignments
- Modules: https://developerdocs.instructure.com/services/canvas/resources/modules
- Outcomes: https://developerdocs.instructure.com/services/canvas/resources/outcomes
