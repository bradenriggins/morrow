# Canvas Item Bank attended proof plan

Reviewed 8 September 2026. This plan verifies the private Canvas Item Banks contract against one authorized course. Morrow's Item Bank reads and changes are all available in code; what this plan establishes is that a real Canvas tenant answers the private routes. It does not authorize a live write. The current assignment permits local and synthetic proof only.

Use a release built from this checkout. Select one signed-in Canvas course where the operator owns an Item Bank and can manage it. Record results under `output/item-bank-live-proof/`. Never record an `Authorization` value. Do not record a digest, prefix, or length for the credential. The local fixture checks in `scripts/test/canvas-item-bank-credential.test.mjs`, `scripts/test/canvas-item-bank-frames.test.mjs`, `scripts/test/canvas-item-bank-executor.test.mjs`, `scripts/test/canvas-item-bank-guard.test.mjs`, and `packages/mcp-server/test/item-bank-repair.integration.test.ts` are implementation evidence only. They are not live Canvas evidence.

## Step 1: Frame observation

Connect the selected numeric course. Start one Item Bank read. Morrow must open an inactive temporary tab at the exact `/courses/{course_id}/external_tools/54065` launch. The first same-frame `GET /api/banks` must establish the private API origin, `contextUuid`, `canvasLocalContextId`, and the short-lived Signature credential. The credential stays in service-worker memory and is cleared when the temporary tab closes. `connector/extension/src/item-bank-credential.js`, `connector/extension/src/item-bank-frames.js`, and `connector/extension/src/item-bank-executor.js` define this boundary.

Stop if the launch, frame, tenant, principal, course, private context, or credential is missing or ambiguous. Save the exact refusal code in `01-frame.json`. Never paste a token or use a credential from another launch.

## Step 2: Exact snapshot record

Run all seven reads. Save each sanitized result, `snapshotSha256`, paging state, target ids, and observation time in `02-snapshots.json`.

| Read | Required target | Snapshot use |
| --- | --- | --- |
| `canvas_item_bank_list_banks` | selected `course_id` | `banks_sha256` for create-bank planning |
| `canvas_item_bank_get_bank` | selected `course_id`, exact `bank_id` | `bank_sha256` for bank and existing-bank operations |
| `canvas_item_bank_list_entries` | selected `course_id`, exact `bank_id` | `entries_sha256` for archive, attach, and entry removal |
| `canvas_item_bank_get_entry` | selected `course_id`, exact `bank_id`, exact `bank_entry_id` | `entry_sha256` for entry removal |
| `canvas_item_bank_get_item` | selected `course_id`, exact `bank_id`, exact `item_id` | `item_sha256` for attach and item update |
| `canvas_item_bank_list_shares` | selected `course_id`, exact `bank_id` | One unpaged observation only. It must report `paginationUnestablished`. `shares_sha256` covers exactly what that one response returned. |
| `canvas_item_bank_list_quiz_draws` | selected `course_id`, exact New Quiz `assignment_id` | Numbered pages through an empty end page. A page or row bound stops the read. The complete result supplies `quiz_entries_sha256` for a bank draw. |

Every bank-specific read first proves that the selected course's fresh bank list contains the exact bank. A bounded or truncated list is not an empty list. Run `morrow_read_item_bank_fan_out` as well: an existing-bank change needs its observed-reach record, and the reviewer acknowledges the exact observed external courses it names. That record never replaces an operation snapshot and never claims a complete account-wide answer.

## Step 3: No-write planning

Build one reviewable operation with the exact current snapshot and intended payload. Do not approve or dispatch it in this assignment. Record the operation name, target ids, payload digest, required snapshot keys, and approval state in `03-plan.json`.

The eleven course-bound changes use these contracts:

| Operation | Required snapshot | Intended effect |
| --- | --- | --- |
| `canvas_item_bank_create_bank` | `banks_sha256` | Create one bank with the reviewed title and language. |
| `canvas_item_bank_rename_bank` | `bank_sha256` | Change only the exact bank title. |
| `canvas_item_bank_archive_bank` | `bank_sha256`, `entries_sha256`, `shares_sha256` | Delete the exact bank. Proved by a 404 from the exact bank read and absence from the selected course's fresh bank list. |
| `canvas_item_bank_create_item` | `bank_sha256` | Create one standalone item and return its new id. |
| `canvas_item_bank_update_item` | `bank_sha256`, `item_sha256` | Replace the exact item with the complete reviewed item payload. |
| `canvas_item_bank_attach_item` | `bank_sha256`, `item_sha256`, `entries_sha256` | Add one entry that links the exact item to the bank. |
| `canvas_item_bank_delete_entry` | `bank_sha256`, `entry_sha256`, `entries_sha256` | Remove one bank association. It does not delete the item object. |
| `canvas_item_bank_share_bank` | `bank_sha256`, `shares_sha256` | Give one exact Canvas course read access. An identical share already in the observed list is refused instead of sent again. |
| `canvas_item_bank_attach_bank_to_quiz` | `bank_sha256`, `quiz_entries_sha256` | Add one fixed random-draw group to one exact New Quiz assignment. |
| `canvas_item_bank_attach_bank_entry_to_quiz` | `bank_sha256`, `entry_sha256`, `quiz_entries_sha256` | Add one exact bank entry to one exact New Quiz assignment. |
| `canvas_item_bank_delete_quiz_bank_entry` | `bank_sha256`, `quiz_entries_sha256`, `quiz_entry_sha256` | Remove one exact quiz entry. Proved by its absence from a complete reread of the quiz-entry list. |

`morrow_plan_item_bank_question_image_alt_repair` uses the same reviewed Item Bank item update. It changes the underlying shared question, so it can affect every consuming quiz. That is why it carries the same `bank_sha256` and `item_sha256` snapshots and the same observed-reach acknowledgement as any other change to an existing bank. It repairs one reviewed image and leaves every other part of the question, including any other image that still needs alternative text, exactly as Canvas holds it.

## Step 4: Attended write if separately authorized

Skip this step for the current assignment. It needs its own written authorization from the course owner, on a course whose Item Bank may be changed.

Immediately before dispatch, Morrow obtains a fresh `54065` credential, proves the same selected course and bank association, rereads every required snapshot source, and compares every SHA-256 value the reviewer pinned. A quiz bank draw also opens the exact selected New Quiz assignment, obtains its assignment-bound builder credential inside that frame, derives and verifies the private quiz id, and rereads the complete quiz-entry list. A mismatch or unreadable source stops the change before Canvas receives it. One successful preflight permits one provider request. There is no automatic retry.

When this step is authorized, record in `04-write.json`: the operation, the target ids, every required snapshot digest, the HTTP status, the verification status and evidence, and the exact reread that proved the saved result. Record a refusal or an uncertain outcome the same way. Never record the credential.

## Step 5: Uncertain outcome settlement

If a dispatched write loses its response or its readback is unavailable, treat the outcome as uncertain. Do not dispatch it again. Save the operation id, target, request time, and refusal or verification reason in `05-uncertain.json`. Reacquire a fresh frame credential and use read-only calls to inspect the exact target. A later authoritative read may settle the saved operation. A guessed retry cannot.

HTTP 408, HTTP 429, every 5xx result, a transport loss, an oversized response after dispatch, and a missing readback can all be uncertain. A clear non-408, non-429 4xx response proves that Canvas refused the request. See `connector/extension/src/canvas-write-outcome.js` and `docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md`.

Update [LIMITATIONS.md](../../LIMITATIONS.md), [MORROW-1.0-HANDOFF-2026-09-06.md](MORROW-1.0-HANDOFF-2026-09-06.md), and the [complete contract matrix](../research/CANVAS-ITEM-BANKS-COMPLETE-CONTRACT-2026-09-08.md) only from the saved attended record. Any step not run stays `live-unverified`.
