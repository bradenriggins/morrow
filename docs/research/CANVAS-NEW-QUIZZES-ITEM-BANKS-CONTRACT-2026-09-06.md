# Canvas New Quizzes and Item Banks: harvested contract

Read through `ssh example-lms-vps` on 6 September 2026. Checkout `/opt/example-attestation-repo` at `06e0eb5d4495413664479c229897aceea3437a91`. This research was read-only. It called no provider, read no credential value, and changed nothing on the host.

Sources read:

| Source | What it establishes |
| --- | --- |
| `example-kit_automation/nq_client.py` | The `/api/quiz/v1/` New Quiz surface and the refusal of the stale `/api/quiz/v1/.../item_banks` routes |
| `example-kit_automation/nq_item_bank_sdk.py` | The private `/api/banks` Item Banks surface, its credential boundary, and its transport guards |
| `example-kit_automation/item_bank_governance.py` | Payload validation, fan-out enumeration, operation freezing, and refusal semantics |
| `scripts/team/mcp/tools/newquizzes.py` | The tool-level workflow: staging, preflight, one dispatch, readback, and uncertain-result handling |
| `docs/canvas/item-banks-sdk.md` | The operational runbook, permission set, verification rules, and known failure modes |

The purpose of this document is to give a Morrow implementer the exact contract without reading ExamplePlatform again. It is a contract description. It is not permission to copy ExamplePlatform source, and it does not prove any of these routes against a Morrow-connected Canvas tenant.

## 1. Three separate surfaces

A New Quiz is a Canvas **assignment** with `submission_types = ["external_tool"]` and `is_quiz_lti_assignment = true`. Three different APIs are involved and they are not interchangeable.

| Surface | Base | Auth | What lives there |
| --- | --- | --- | --- |
| Classic Canvas REST | `/api/v1/...` | Canvas session cookie plus CSRF | The linked assignment record: name, grading type, due and availability dates, points, publication |
| New Quizzes | `/api/quiz/v1/...` | The same Canvas session cookie and CSRF, on the same Canvas host | The quiz record, its `quiz_settings`, and its directly attached items |
| Item Banks (private) | `/api/banks/...` on the tenant Quizzes API host | A short-lived `banks.build` credential issued inside the Item Banks LTI launch, sent as `Authorization: <token>` with `AuthType: Signature` | Banks, bank entries, bank items, and bank shares |

Calling `/api/v1/.../quizzes/{id}` with a New Quiz id returns 404. Item Bank content is invisible to every `/api/quiz/v1` item read. Classic Canvas Question Banks are a different feature and are not a fallback for New Quizzes Item Banks.

**The stale routes below returned 404 and must not be used as the Item Banks path:**

```text
GET|POST /api/quiz/v1/accounts/{account_id}/item_banks
GET|POST /api/quiz/v1/courses/{course_id}/item_banks
```

## 2. New Quizzes surface: `/api/quiz/v1/`

All request bodies on this surface are **JSON**, not form encoding.

| Operation | Method and path | Request body | Notes |
| --- | --- | --- | --- |
| Create quiz | `POST /api/quiz/v1/courses/{course_id}/quizzes` | `{"quiz": {"title", "instructions"?, "points_possible"?, "quiz_settings"?}}` | `title` is required. The create endpoint does not synthesize item content. |
| Read quiz | `GET /api/quiz/v1/courses/{course_id}/quizzes/{quiz_id}` | — | Returns a New Quiz envelope. It is not a Classic quiz shape. |
| Delete quiz | `DELETE /api/quiz/v1/courses/{course_id}/quizzes/{quiz_id}` | — | |
| Update quiz settings | `PATCH /api/quiz/v1/courses/{course_id}/quizzes/{quiz_id}` | `{"quiz": {"quiz_settings": <complete merged block>}}` | See the merge rule below. |
| List items | `GET /api/quiz/v1/courses/{course_id}/quizzes/{quiz_id}/items` | — | The authoritative direct-item membership list. |
| Add item | `POST /api/quiz/v1/courses/{course_id}/quizzes/{quiz_id}/items` | `{"item": {...}}` | |
| Delete item | `DELETE /api/quiz/v1/courses/{course_id}/quizzes/{quiz_id}/items/{item_id}` | — | |

### 2.1 The quiz_settings merge rule

A partial `quiz_settings` PATCH can replace the whole block rather than merge into it. The harvested tool therefore refuses to send a partial block blind. Its sequence is:

1. Read the quiz and take its exact current `quiz_settings` object.
2. Compare that object, byte for byte after stable JSON encoding, against the `current_quiz_settings` the caller supplied from its own fresh read. A difference is a stale precondition and no PATCH is sent.
3. Send `{...current, ...requested}` as the complete block.
4. Report which keys were preserved from the current settings and which the caller changed.

Failing to read the quiz before the PATCH is treated as a hard error, not an advisory one: the merge is the safety property.

### 2.2 The in-place item edit hazard

New Quizzes merges `interaction_data` sub-elements **by `id`**. An in-place `PATCH` that regenerates choice, question, or blank ids does not replace the old elements. It orphans them into blank "ghost stub" choices, and they accumulate. This was observed in production on 1 June 2026 on one item that ended with 10 real choices and 18 blank ones.

The harvested rules are:

- For any structural change to a choice-bearing item (choice, multi-answer, ordering, categorization), **delete the item and add the replacement**. A clean delete-then-add never merges. The replacement gets a new item id.
- Delete-then-add is **not atomic**. If the add fails after the delete succeeds, the quiz temporarily has one fewer item, and the membership list is the authority on what is actually there.
- An in-place `PATCH` is safe only when every existing id is preserved and only non-structural field values change. The harvested body-only tool sends `{"item": {"entry": {"item_body": "<html>"}}}` after checking a supplied `expected_body_sha256` against a fresh read, and records that item id, position, points, choices, answer key, feedback, and shuffle settings are preserved.
- Before an applying update the harvested tool also compares the interaction id sets of the current item and the proposed item. Any change to the choice, question, or blank id sets is refused.

### 2.3 Item ordering

Item order is read from the item list. Every item must have a stable non-duplicate `id` and an integer `position` at least 1 with no duplicates; anything else is a provider-state error, not a recoverable condition. The order is the item ids sorted by position. A reorder is confirmed by a token derived from the course id, quiz id, expected current order digest, and desired order digest, and verified afterward by re-reading the complete list and comparing the exact id sequence.

### 2.4 Quiz record versus assignment record

Title, instructions, and `quiz_settings` belong to the `/api/quiz/v1` quiz record. The assignment name, grading type, and dates belong to the linked `/api/v1/courses/{course_id}/assignments/{assignment_id}` record. The harvested update planner reads both, splits the requested change across the two bodies, and reports a combined before state. A single-surface update cannot change both.

### 2.5 Stimulus

**There is no Stimulus contract in the harvest.** The strings `stimulus` and `stimuli` do not appear anywhere in the four Python sources. The harvest establishes that the New Quiz item API exists and that `QuestionItem` records can be created, read, updated in place under strict conditions, and deleted. It does not establish a preservation or dependency contract for `StimulusItem` records or for the items bound to a stimulus. Any Morrow stimulus repair remains blocked on evidence this harvest does not contain.

## 3. Item Banks surface: `/api/banks/`

### 3.1 Credential boundary

1. The Item Banks LTI tool is launched inside the selected course.
2. Canvas issues a short-lived launch token and exchanges it at `/api/sdk_tokens/banks.build`.
3. Requests go to the tenant Quizzes API host with `Authorization: <token>` and `AuthType: Signature`.

The rules the harvest enforces around that credential:

- The token is a short-lived secret. It may live in memory for one run. It is never logged, persisted, or written into evidence files.
- Evidence URLs are redacted for `launch_token`, `access_token`, `token`, `jwt`, `signature`, and `oauth_signature` query parameters before they are recorded.
- The request path must be **host relative**. An absolute URL passed where a path is expected is refused, because it would let the caller choose which host receives the credential. This guard runs for reads as well as writes.
- An HTTP method the client does not recognise is refused rather than treated as a read. "I do not recognise this method" and "this is a read" must not share a branch.
- The captured credential is bound to a course. A credential whose course does not match the operation target is a permission error.
- The daemon clears its captured credential on every navigation, and a credential captured before this launch began is rejected on a timestamp comparison. A shared session must not hand back someone else's token.

Canvas's own single-page router frequently collapses the top-level page to a not-found state a few seconds after a successful Item Banks launch, taking the frame with it. The launch still succeeded. ExamplePlatform treats a captured token as the authoritative "the launch worked" signal and falls back to direct server-side HTTP once the frame is gone.

**Morrow cannot use that fallback.** Morrow's boundary is that the credential never leaves the authenticated frame. For Morrow, a collapsed frame means the request cannot be made and, after a dispatch, the result cannot be confirmed. That is an uncertain result, not a failure.

### 3.2 Routes

| Operation | Method and path | Body | Response |
| --- | --- | --- | --- |
| List banks | `GET /api/banks?course_id={course_id}&page={n}` | — | Array of banks. Paged; an empty page ends the walk. |
| Read bank | `GET /api/banks/{bank_id}` | — | Bank object |
| Create bank | `POST /api/banks` | `{"bank": {"title", "language"}}` (`language` defaults to `en`) | Created bank |
| List entries | `GET /api/banks/{bank_id}/bank_entries?page={n}` | — | Array of entry rows. Paged. |
| Read entry | `GET /api/banks/{bank_id}/bank_entries/{bank_entry_id}` | — | Entry row, sometimes carrying the item |
| Delete entry | `DELETE /api/banks/{bank_id}/bank_entries/{bank_entry_id}` | — | Removes the association only |
| Create item | `POST /api/banks/{bank_id}/items` | `{"item": {...}}` | Created item, with `id` |
| **Read item** | `GET /api/banks/{bank_id}/items/{item_id}` | — | The item object. This is the exact comparator for an item write. |
| Update item | `PATCH /api/banks/{bank_id}/items/{item_id}` | `{"item": {...}}` | Updated item |
| Attach existing item | `POST /api/banks/{bank_id}/bank_entries` | `{"bank_entry": {"bank_id", "entry_type": "Item", "entry_id"}}` | Created entry row |
| List shares | `GET /api/banks/{bank_id}/shared_banks[?entity_id=&entity_type=]` | — | Array of share rows |
| Share bank | `POST /api/banks/{bank_id}/shared_banks` | `{"shared_bank": {"entity_id", "entityType", "bank_id", "permission"}}` | Created share |
| Archive bank | `DELETE /api/banks/{bank_id}` | — | **Not a normal operation.** See 3.6. |

If a body is supplied under key `item`, it is used as the whole body. Otherwise it is wrapped as `{"item": <body>}`. The same rule applies to bank entries and shares in their own shapes.

`entityType` in the share body is camel case while `entity_id` and `bank_id` are snake case. Only `entity_type = "course"` and `permission = "read"` were verified live.

Note the identifier distinction. An entry row has its **own** `id` (the bank-entry row id) and an `entry_id` that points at the item. Deleting an entry uses the row `id`. Reading or updating an item uses the item id.

### 3.3 Entry rows do not always carry their item

An entry row may embed the item under `item`, `entry`, `current_version`, or `data`, possibly nested one level deeper under `item` or `data`, or the row itself may carry `item_body` and `interaction_data`. It may also carry none of these. The harvested resolver:

1. If the row's `entry_type` is `Item` and its `entry_id` matches the wanted item id, read `GET /api/banks/{bank_id}/items/{item_id}` and use that.
2. Otherwise, read the full entry with `GET /api/banks/{bank_id}/bank_entries/{bank_entry_id}` and search the shapes above.
3. Accept the result only if the linked item id from the entry, or from the embedded item's own `id`, equals the wanted item id.

Reading a list row is not reading an item.

### 3.4 Bank creation is two phases

`POST /api/banks/{bank_id}/items` creates a standalone item object. **It does not put the item in the bank's entries.** The item becomes a bank entry only after a separate `POST /api/banks/{bank_id}/bank_entries` naming that item id.

The harvested flow is therefore:

1. **Phase one, stage.** Validate the payload, dispatch one `POST .../items`, take `id` from the response, then verify with `GET .../items/{id}` and an exact payload comparison. Record a durable phase-one receipt binding the descriptor, course, bank, item id, payload digest, effect receipt, and readback.
2. **Phase two, attach.** Verify the phase-one receipt, its job and owner binding, the payload digest, and the response-verified staged item. Then dispatch one `POST .../bank_entries`, then re-read entries and the attached item.

If phase one succeeds but the receipt cannot be written, the item exists and must not be created again; the state is `completed_without_handoff` and it must be reconciled by item id. If phase one is indeterminate, phase two accepts a recovery path that binds the earlier provider response digest to this owner, course, bank, item id, and unchanged payload instead of a normal receipt.

A readback of `bank_entries` immediately after phase one **cannot** confirm the create, and its absence is not evidence that nothing was created.

### 3.5 Verification rules per write

| Write | Required evidence |
| --- | --- |
| Create bank | Capture the created bank response |
| Create item in bank | Create the item, verify it by item read, create the entry, then list entries |
| Attach existing item | List entries before and after |
| Update item | Read the item before, `PATCH`, read the item after and compare exactly |
| Remove item from bank | Resolve the entry before, `DELETE` the entry, list entries after and confirm that row is gone |
| Share bank | Read shares before and after |

If the post-write readback fails, the write is reported **unverified**. It is not reported as finished, and it is not repeated.

### 3.6 Full bank deletion and archive

Full bank deletion or archive is not exposed as a normal operation. In the harvest it requires an explicit administrator environment flag, a dependency preflight that is complete and shows zero uses, and fresh global counts showing zero bank entries and zero uses. A disposable canary may archive its own test bank. Production work needs a separate approval, a dependency audit, and a purpose-built runbook.

## 4. Fan-out: the precondition for editing an existing bank

An Item Bank is shared machinery. An edit reaches every quiz and every course that draws from it, including a course nobody opened. Any `add`, `update`, `remove`, or `share` on an existing bank is refused until the propagation set has been established and recorded.

### 4.1 The record

Schema `canvas.item-bank.fan-out.v1`. Fields:

| Field | Meaning |
| --- | --- |
| `bank_id`, `course_id`, `actor` | Exact binding of the record |
| `established_at` | ISO 8601 with a timezone |
| `sources` | One row per enumeration source: `{name, pages, exhausted}` |
| `unreachable` | Sorted union of missing sources, unexhausted sources, and explicitly unreachable names |
| `complete` | `true` only when `unreachable` is empty |
| `consumers` | Sorted, de-duplicated `{course_id, entity_type, entity_id}` rows |
| `consumer_count` | Length of `consumers` |
| `external_course_ids` | Sorted set of consumer course ids that are not this course |
| `consumers_sha256` | Stable digest over the normalized consumer list |

The three required sources are exactly `bank_entries`, `shared_banks`, and `quiz_uses`. A missing source name, or a source whose walk was not exhausted, sets `complete` to `false`.

### 4.2 Enumeration

- `bank_entries` is walked page by page through `GET /api/banks/{bank_id}/bank_entries` until an empty page, within a page budget. Exceeding the budget is an error, not a truncation.
- `shared_banks` is read through `GET /api/banks/{bank_id}/shared_banks`. Rows whose entity type is `course` contribute one consumer each.
- `quiz_uses` **has no private-SDK route.** The Item Banks API exposes no way to list the quizzes drawing from a bank. It must be supplied from a Canvas-side enumeration. When it is not supplied, that source is recorded as unread and the whole set is incomplete.

The governing distinction, stated in the source: *"no course draws from this bank" and "nobody enumerated the courses" are different answers, and only the first one authorises an edit.* A failed enumeration is never recorded as an empty fan-out.

### 4.3 Admission

An edit is refused when any of these hold:

- No fan-out record is present, or its schema is not the expected one.
- The record is for a different bank or a different course.
- `complete` is not exactly `true`, or `unreachable` is non-empty.
- `consumers_sha256` does not match a fresh digest of the record's own consumers.
- `consumer_count` does not match the consumer list length.
- `established_at` is unparseable, has no timezone, or is more than **one hour** old.
- `external_course_ids` disagrees with the external courses implied by the consumers.
- The operation's `fan_out_acknowledged_course_ids` is not exactly the same set as `external_course_ids`.

The refusal message names every external course the bank reaches.

### 4.4 Extra preflight for share, use, and archive

These actions additionally require a `preflight` object carrying `bank_entry_count`, `global_item_count`, `share_count`, `use_count`, and `observed_at`. All four counts must be non-negative integers, `observed_at` must carry a timezone, and it must be at most **15 minutes** old. Archive additionally requires both `bank_entry_count` and `use_count` to be zero.

## 5. Freezing an operation

Before a private write, the harvest builds an immutable target from a fixed field set: `account_id`, `course_id`, `entity_id`, `entity_type`, `bank_id`, `item_id`, `payload_sha256`, `allowed_requests_sha256`, `source_sha256`, and `actor`. `course_id` must match `[1-9][0-9]*`. `bank_id` may be empty only for `create`. `item_id` may be empty only for `create`, `add`, `import`, `share`, `use`, and `archive`.

The operation also carries `allowed_requests`: an explicit list of `{method, path, body, body_sha256}` entries. Admission checks that:

- Every route is one of the exact method-and-path pairs the declared action permits, and no other.
- Each `body_sha256` equals a stable digest of its own body.
- Outside an import, no method-and-path pair repeats.
- For `add` and `update`, the body is exactly `{"item": <payload>}` and the payload digest equals the frozen `payload_sha256`.
- For `update`, the operation carries `before`, `after`, and a non-empty `preserved_fields` list, every preserved field is equal in `before` and `after`, and the request body preserves each of them from `before`.
- A plan-only action carries no write routes at all.

At dispatch, the authorizer looks up the exact `(method, path)` pair and compares a stable digest of the actual body against the accepted digests. Anything else is outside the frozen operation. The request body is frozen once and the same bytes are both digested and sent, so the digest cannot describe a different payload than the one on the wire.

## 6. Item payload validation

Applied before any private write, and to a proposed update as well as a create.

**Media, for every type.** An `<img>` without an `alt` attribute is refused. Every `src` on `img`, `audio`, or `video` must start with `https://`, `/courses/`, or `/api/v1/files/`.

**choice** (`interaction_type_id` `1`, or slug `choice` / `multiple_choice`). At least two choices. Each choice needs a valid id and a non-blank body. Ids must be unique. Every value in `scoring_data.value`, list or scalar, must be one of those ids. Each choice body is media-checked.

**matching.** `interaction_data.questions` must be a non-empty list of objects with unique valid ids. `scoring_data.value` must be an object whose key set is exactly the question id set. `scoring_data.edit_data.matches` must cover exactly every question id. The harvest notes explicitly that the inline New Quiz `q-1` id convention does **not** apply to Item Bank payloads; only presence and uniqueness are checkable there.

**numeric.** `scoring_data.value` must be a real number, not a boolean. `interaction_data.units`, if present, must be non-empty text. `interaction_data.dimensions`, if present, must be a non-empty object whose `min`, `max`, and `step` are numbers, with `min` at most `max`.

**rich_fill.** `interaction_data.blanks` (or `entries`) must be a non-empty list of objects with unique valid ids. Each blank's type must be one of:
- `openEntry`, needing an explicit non-empty answers list of scalars;
- `TextInChoices`, needing at least two listed choices and a correct value that is one of them;
- `wordbank`.

Word-bank blanks cannot be mixed with the other kinds. When they are used, `interaction_data.word_bank_choices` needs at least two choices with unique valid ids; `scoring_data.value` must be a list whose ids are exactly the blank ids; each blank's scoring must have a non-empty `value` whose `blank_text` equals it and a `choice_id` that exists; the item body must contain `id="blank_<id>"` markers matching exactly the blank id set; and `scoring_data.working_item_body` must contain the answers in backticks in blank order.

**Every other interaction type passes through.** This is a corrected behaviour and the correction matters. An earlier hard allowlist of four types made ExamplePlatform refuse categorization, multi-answer, essay, true-false, ordering, file upload, formula, and hot spot **before Canvas ever saw them**. Proven on 29 August 2026: three items were built and all three were rejected locally, so nobody learned what Canvas would have said. The rule now is that a validator which cannot check a shape must not therefore forbid it. Media validation still runs for every type, and Canvas is the authority on its own schema. A malformed payload reaching Canvas and returning a typed provider error is strictly better than telling a user a question type does not exist.

## 7. Failure semantics

### 7.1 Classification of a dispatched request

| Condition | Disposition |
| --- | --- |
| Permission error raised before send | **failed** — nothing was sent |
| Typed RPC rejection: invalid parameters, bound-target mismatch, missing mutation authority | **failed** — nothing was sent |
| HTTP 4xx **except 408 and 429** | **failed** — the provider refused |
| HTTP 408, 429, any 5xx, transport error, timeout, unreadable response | **indeterminate** |

An indeterminate result is never retried. The harvested recovery text is: the effect may have happened; do not retry; fresh-read the exact bank target and reconcile the durable receipt.

### 7.2 Result states

| State | Meaning |
| --- | --- |
| `completed` + `verified_present` | Accepted and confirmed by a fresh read |
| `provider_refused` | Definitely not applied |
| `applied_unverified` | A response came back but the readback did not confirm it |
| `unknown_after_send` | No usable response |
| `reconciliation_required` | This exact effect already has a durable receipt; nothing was resent |
| `failed_before_send` | The effect reservation was unavailable; nothing was sent; safe to retry |

`safe_to_retry` is `false` for every state except `failed_before_send`.

### 7.3 Readback comparison

An item readback compares a stable digest of the expected payload against the actual item. When the shapes differ, the comparison is made on a projection of the actual value restricted to the keys the expected value declares, so an extra provider-assigned field does not read as a mismatch and a missing field does. A readback that does not match reports `stale_or_incomplete_readback`; it does not report success and it does not trigger a repeat.

### 7.4 Named error conditions from the runbook

| Condition | Meaning |
| --- | --- |
| No credential | The Item Banks page was not opened in this session; open it once and retry |
| 401 or 403 | Session or role problem; refresh sign-in, confirm the role has Item Banks permissions, reacquire the credential |
| 404 on `/api/quiz/v1/.../item_banks` | The stale REST path, not the supported route |
| Readback mismatch | Stop. Report the exact bank id, item id, bank-entry id, and the failed verification step |
| Frame not found after a successful launch | Canvas SPA routing collapsed the frame; the launch still succeeded |

## 8. Role permissions

These Canvas permissions are necessary for Item Bank work: `Item Banks - manage account`, `Item Banks - share with subaccounts`, and `Question banks - view and link`. They are **not sufficient**. The work still needs the Item Banks credential captured from the live launch. A role check is not an access check.

## 9. What this harvest does not establish

- Any Stimulus create, read, update, or preservation contract.
- Any route that lists the quizzes drawing from a bank. `quiz_uses` must come from a Canvas-side enumeration or be recorded as unread.
- Pagination for `shared_banks`. The harvested read is a single unpaged GET and records one exhausted page. A bank shared into more contexts than one response carries would be silently under-counted by that read alone.
- That `/api/banks` results are scoped to one course. `list_banks` takes a `course_id` and the credential is course-bound, but no route proves that a given bank or entry belongs only to the selected course. `shared_banks` is the closest available course-association evidence and it covers shares only.
- Any behaviour on a Morrow-connected Canvas tenant. Every route here is described from ExamplePlatform source and its own dated receipts. For Morrow it is **live-unverified** until Morrow observes it against a course the user can access.

**What Morrow has implemented against this contract, as of 7 September 2026.** The routes, bodies and identifier rules of 3.2 and 3.3 are in `connector/extension/src/item-bank-executor.js`, including the item read this document names as the exact comparator for an item write, a share body limited to `entity_type: "course"` and `permission: "read"`, and the rule that a list row is not an item. The credential boundary of 3.1 is enforced by the frame selection in `connector/extension/src/item-bank-frames.js`, and ExamplePlatform's server-side fallback is deliberately absent: a frame that collapses before the request means nothing was sent, and one that collapses after it leaves the result uncertain. The fan-out record of 4.1 to 4.3 is `packages/mcp-server/src/item-bank-fan-out.ts`, under the schema name `morrow.canvas.item-bank.fan-out.v1`, with the in-frame copy `connector/extension/src/item-bank-fan-out.js`; it keeps the distinction of 4.2 by recording an unread source instead of an empty list, and it records a `shared_banks` response as long as the request as unread, because paging that route is not established. The freeze of section 5 is `connector/extension/src/item-bank-guard.js`, planned by `packages/mcp-server/src/item-bank-repair.ts`. That guard is the only way past the hold on the question update, whether the change carries a person's approval or the single Edit category `canvas_item_bank_question_image_alt`, and the sequence is fixed: one item read before, one entry read, one PATCH, one item read after, compared as 7.3 requires, with the dispositions of 7.1 mapped to an uncertain result that is never repeated. The payload rules of section 6 run in the executor before a bank item create or update, applying the media rules to every type and passing an unknown type through to Canvas, and they deliberately do not run on the guarded alternative-text repair. Nothing else here is implemented: the two-phase bank item creation and its receipt (3.4), the extra preflight for share, use and archive (4.4), archive itself (3.6), and every Stimulus behaviour (2.5) have no Morrow equivalent, and those writes stay held. The proof is `scripts/test/canvas-item-bank-executor.test.mjs`, `scripts/test/canvas-item-bank-frames.test.mjs`, `scripts/test/canvas-item-bank-guard.test.mjs`, `scripts/test/canvas-item-bank-fan-out.test.mjs`, `scripts/test/bridge-settings-contract.test.mjs`, `packages/mcp-server/test/item-bank-fan-out.test.ts`, `packages/mcp-server/test/item-bank-repair.test.ts` and `packages/mcp-server/test/item-bank-repair.integration.test.ts`, all passing in this checkout on 7 September 2026 over fixtures Morrow itself defines. The bullet above still holds for every one of them: none of it is evidence about a Canvas tenant.
