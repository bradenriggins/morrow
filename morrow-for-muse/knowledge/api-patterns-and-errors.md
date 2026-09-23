# API patterns and error codes through the Chromium lane

Every Canvas call runs as in-page `fetch()` inside the educator's own
authenticated Chromium session, via CDP on 127.0.0.1:19223. No
shell-side HTTP client may carry auth material. That shapes every
pattern below: you write URLs and bodies, never tokens, cookies, or
headers carrying identity.

## Request shapes

Paths are Canvas REST paths under the tenant base, e.g.
`/api/v1/courses/{course_id}/assignments/{id}`. `{course_id}` slots
fill from `--params` JSON. New Quiz paths live under `/api/quiz/v1/`
(e.g. `/api/quiz/v1/courses/{course_id}/quizzes`), and Item Bank
paths live under `/api/banks/...` on the tenant's quiz-api host (the
executor egresses them through the Item Banks SDK lane automatically;
see `knowledge/item-banks-sdk.md`).

Write bodies use Canvas's nested contract per surface:

- assignment: `{"assignment": {"name": "...", "points_possible": 10}}`
- assignment group: `{"assignment_group": {"name": "..."}}`
- discussion: flat params (`{"title": "...", "message": "..."}`,
  NOT a `discussion_topic` wrapper; only the `assignment` subobject
  nests when creating a graded discussion). Canvas silently swallows
  a wrapped body and returns 200 with a default-ish object, which is
  exactly the D-009 failure class. AUDIT NOTE: the executor's write
  selftests still encode the `{"discussion_topic": {...}}` wrapper,
  and only one discussion write is live-proven through the Chromium
  lane (C-238, discussion date_details PUT 204, 2026-09-21 write
  battery; SCOPE.md withholds discussion writes from v1, and the
  admission policy holds them). The flat
  shape is the production-verified contract; the executor unwraps
  one nesting level for readback comparison and prevalidation but
  sends the body unchanged, so a wrapped body still hits D-009.
  Correct the executor the day discussion writes are ever proven on
  this lane.
- wiki page: `{"wiki_page": {"title": "...", "body": "..."}}`
- module: `{"module": {"name": "..."}}`
- New Quiz item: fields nest under `item.entry` (partial
  `{"item": {"title": ...}}` updates return HTTP 400; the entry-nested
  shape is required). Opposite of bank items, which nest under
  top-level `item`.
- Bank item: `{"item": {...}}` (top-level item).
- PUT for page content goes to `/pages/{url}`, not `/pages/{id}`.

The executor unwraps these nested bodies before comparing intent
fields on readback (`_unwrap_canvas_body`).

## Pagination

Canvas list GETs return paged arrays (the 2026-09-21 GET battery
receipts show default pages like `body array[10]`). Two things bound
what an agent sees:

- The synthetic catalog entry's result block caps receipts at 262144
  bytes, tail-truncated. A huge list comes back cut at the tail; the
  receipt is a sample, not the whole list.
- Through the CLI, `--params` fills path-template slots only; there is
  no CLI flag for query args like `per_page` or `page`. You cannot ask
  for a bigger page from the command line. To page deliberately,
  dispatch programmatically through `dispatch_catalog_op(...)` with
  `extra={"query": {"per_page": 100, "page": 2}}`.

Treat any list receipt as partial unless you paged through it
yourself. For audit-grade verification (e.g. "is the deleted object
absent"), the terminal member GET or the follow-up readback matters,
not the list length.

## Pre-dispatch guardrails (shipped in the executor)

These run before any provider call, live-proven through the Chromium
lane on course 89585 (defects D-009/D-010/D-011; the defect log is
operator history and is not part of this tree):

- **Post-write readback**: after a create/update on assignment-group,
  discussion, assignment, module, quiz, or page surfaces, the executor
  GETs the created/updated object and compares requested scalar intent
  fields (name, title, position) against persisted values. A mismatch
  raises `WriteFieldMismatch`, journaled as failed with
  `uncertain=False`. Never reported as success. Why: Canvas swallows
  malformed nested params and returns HTTP 200 with a default-ish
  object (e.g. assignment-group name "Assignments", position 60).
- **Required-field prevalidation**: discussion POST requires a
  non-empty title; assignment and assignment-group POST require a
  non-empty name; module POST requires a non-empty name; page POST
  requires a non-empty title. Refused writes raise
  `WritePrevalidationFailed`, make zero provider calls, and journal
  a claim record plus a journaled release under the caller's op id,
  leaving the op id reusable. Why: an empty-body discussion
  POST returned 200 and created a broken "No Title" object (D-010).
- **Page PUT pre-check**: the executor GETs the page URL first; a 404
  (or any unconfirmed result) refuses the write before any PUT reaches
  Canvas. Why: page PUT upserts, so an update aimed at a missing page
  silently creates one (D-011).

## Error codes: what each means here, and the recovery

| Status | Meaning in this architecture | Recovery |
|---|---|---|
| 401 | Three flavors. (1) Canvas-origin 401 with `{"status":"unauthenticated"}`: the browser session died. (2) Item Bank SDK lane 401 (e.g. quiz_entries routes): wrong authorization scope, the banks.build token has no policy for that route, held on evidence-hold. (3) New Quizzes LTI-provisioning 401: `/api/quiz/v1/...` 401s while classic `/api/v1/...` works on the same session. The educator has never launched a New Quiz in this tenant. | Canvas 401: stop, tell the educator, re-sign-in through the helper, re-verify principal, mint a fresh approval for the retry. SDK 401: do not retry; the route is evidence-hold. NQ-provisioning 401: do NOT run dead-session recovery; the educator opens any New Quiz once in a real browser, then you retry. Full diagnostic order in `new-quizzes-contract.md`. |
| 403 | Canvas refused the educator's own permissions for that action. | This is provider truth about their access level. Do not work around it; report it. |
| 404 | Resource missing, or delete receipt (see below). Also the provider-anomaly case: direct item GET 404s on items that exist (use the entry GET, IB-10). | After a DELETE, a 404 on the follow-up member GET confirms the delete (D-005 rule: 404-after-delete counts as success ONLY with that follow-up GET confirming absence; the rule is documented procedure, not code). For classic quizzes, index removal is the delete receipt (D-002: member GET may still serve the deleted quiz). |
| 422 | Canvas rejected the payload (validation, bad shape). | Fix the request shape, never resend the same body hoping it changes. 4xx fails fast; the executor never retries a 4xx. |
| 429 | Rate limited. | The executor retries reads with backoff (up to 4 attempts). If it persists, slow down, spread the work across runs, and retry later. Never hammer the provider; the executor journals the attempts. |
| 408/500/502/503/504 | Transient provider or transport errors. | Reads retry automatically with backoff. **Writes are not retried on ambiguity**: a 429/5xx on a write raises `UncertainWrite`, journaled as uncertain with the op id. Report it as uncertain with the op id; never re-fire the write blindly, since the effect state is unknown and a retry could double-apply. Only failures that prove the provider never saw the request (connection-refused/DNS on every attempt) may retry internally, and if all attempts fail that way the write raises `WriteNotAttempted` instead. |

Transport failure on a write raises `UncertainWrite`: effect state
unknown, journaled as uncertain, not retried. The exception is
`WriteNotAttempted`: failures that prove the provider never saw the
request (connection-refused/DNS on every attempt) mean nothing was
applied, so the op id stays reusable after the claim is released, and
the failure is journaled under a fresh event id, never as the op's
own record. Session death after claim raises `ChromiumSessionDead`
and journals a claim record plus a journaled release under the
caller's op id, so the op id stays reusable; pre-claim death journals
nothing at all. Either way the approval was already consumed, so the
retry needs a freshly signed approval AND educator re-sign-in.

## The CSRF 422: a silent-failure class the Chromium lane must never produce

Writes to `/api/quiz/v1/...` (and classic `/api/v1/...` writes from a
browser context) require the `X-CSRF-Token` header matching the
session's `_csrf_token` cookie. Without it, Canvas returns 422 with
a generic `unprocessable_content` error that gives no hint about the
real cause. This is the canonical silent-failure trap: a correct
payload with a missing header reads as a broken payload.

In this package the trap is closed by construction on the Chromium
lane: every non-GET fetch runs in page context with `X-CSRF-Token`
harvested fresh from the `_csrf_token` cookie in that context and
sent alongside the request (`transport/local_chromium.py`). GETs do
not carry it; only writes do.

Why it still belongs in this file: any write path that is NOT the
Chromium page-context fetch (a hand-rolled path, a new lane, the
retired browser-task form lane) hits this 422. If a write fails with
422 `unprocessable_content` and the payload is correct, check the
CSRF header first. 422 means fix the request shape (or the header),
never resend the same body hoping it changes.

## Provider-verified gotchas (ported from production doctrine)

Eight Canvas behaviors that break automation when assumed away.
Ported from production documentation; none of these are new Canvas
news, which is exactly why they keep biting.

1. **Page listings omit bodies.** `GET /pages` returns no `body`
   unless `include[]=body` is passed. A plain page list is not enough
   when the work needs page content; fetch each page individually or
   pass the include.
2. **Page slugs win over numeric ids.** Bare `/pages/7` can resolve
   the page whose slug is `"7"` instead of page id 7. When numeric
   addressing is truly needed, use `/pages/page_id:7`. Default to
   live slugs from the page list.
3. **Assignment overrides are per-assignment.** The pattern is
   `GET/POST /assignments/{id}/overrides` and
   `PUT /assignments/{id}/overrides/{override_id}`: create or update
   one override at a time. Do not assume a bulk update endpoint, and
   changing an assignment's `due_at` does NOT move its existing
   overrides.
4. **Blueprint locks are `restricted_by_master_course`, not
   `lock_info`.** On blueprint-associated content, check that field
   before writing; `lock_info` is date/module lock state and proves
   nothing about blueprint. Blueprint rows are never-dispatch in this
   package; never work around a blueprint lock.
5. **New Quizzes is `/api/quiz/v1/`, Item Banks is the SDK.**
   Covered above and in `new-quizzes-contract.md`. The stale public
   routes `/api/quiz/v1/{accounts,courses}/.../item_banks` 404 and
   must not be used; their 404 is not a feature-flag problem and is
   not the supported path.
6. **Rate limiting is cost-based, not a fixed quota.** Canvas answers
   with 429; `X-Rate-Limit-Remaining` is the remaining-budget header
   and `X-Request-Cost` exposes the request cost. Parallel requests
   pay a pre-flight penalty, so concurrency burns quota faster than
   sequential calls. Do not fan out large parallel sweeps without a
   reason; prefer sequential and back off on 429.
7. **Content migrations use `select[...]`, not `copy[...]`.**
   `migration_type=course_copy_importer` with `select[assignments][]`,
   `select[pages][]`, `select[modules][]` for initial selection. Old
   `copy[...]` guidance is stale.
8. **Discussion updates are flat** (see Request shapes above).

## Idempotency and provider quirks worth knowing

- **Deletes are not status-idempotent.** A second DELETE on a
  blackout date returned 404 `{"errors":[{"message":"The specified
  resource does not exist."}]}` (D-005). The canonical delete receipt
  is the follow-up GET confirming absence, not the DELETE status.
- **New Quiz delete lifecycle**: always delete a New Quiz through the
  quiz API, never through the Canvas assignment endpoint. Deleting the
  assignment first left orphan quiz 506477 (audit correction in the
  catalog, NQ-W1 superseded by the full lifecycle).
- **No PUT on New Quiz paths.** Update is PATCH. The executor guards
  this (`guard_new_quiz_request`).
- **Bulk assignment date update** takes a bare array body; the object
  wrapper 400s (C-37 evidence). Pass the array as `--body`
  (`[{"id": 5, "all_dates": [{"base": true, "due_at": "..."}]}]`).
- **Batch override update** needs `assignment_id` in the body; without
  it the first attempt 400'd (C-36 evidence).
- **Unshare (bank shares)**: no unshare via DELETE (404s). Unshare is
  PATCH /api/banks/{bank}/shared_banks/{id} with
  {shared_bank:{permission:"removed_access"}} (proven 2026-09-21,
  share 38934; list verified clean). Bank archive is the provider's
  whole-bank delete.
- **Quiz whole-archive is unsupported**: no archive action in the
  served tool bundle (NQS-7).
- **Learner-bearing routes** (`/users/`, `/enrollments`,
  `/submissions`, `/gradebook`, `/grades`, `/analytics`,
  `/ai_conversations`, `/ai_experiences`) are learner data: they
  dispatch only on the Chromium lane with the encrypted learner vault,
  where every receipt is de-identified, and are refused
  (`LearnerDataGated`) everywhere else, on every tenant; there is no
  bypass. `/users/self` is the exception.
