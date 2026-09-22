# Canvas Item Banks complete contract matrix

Reviewed 8 September 2026. This matrix separates official Canvas user workflows, the public Canvas API, the ExamplePlatform-proven private Item Banks routes, Morrow's current contract, and live proof. No live provider write was made for this audit. The private `/api/banks` surface remains live-unverified in Morrow until the attended proof plan runs against an authorized Canvas course.

Morrow reads and changes Canvas Item Banks. All 18 Item Bank operations are available: seven reads and eleven course-bound changes. Every change reads the exact current state first, compares it with the state the reviewer approved, sends one request, and reads Canvas again to prove what was saved.

## Sources and evidence boundary

- [New Quiz Items API](https://developerdocs.instructure.com/services/canvas/resources/new_quiz_items) documents quiz item reads and the public `QuestionItem` create, update, and delete contract. It does not document Item Bank management.
- [Manage Item Banks](https://community.instructure.com/en/kb/articles/661075-how-do-i-manage-item-banks-in-new-quizzes), [Create an Item Bank](https://community.instructure.com/en/kb/articles/661076-how-do-i-create-an-item-bank-in-new-quizzes), [Import an Item Bank](https://community.instructure.com/en/kb/articles/661079-how-do-i-import-a-question-bank-from-a-qti-package-in-new-quizzes), [Add an individual bank item](https://community.instructure.com/en/kb/articles/661080-how-do-i-add-an-item-from-an-item-bank-to-a-quiz-in-new-quizzes), [Edit an Item Bank item](https://community.instructure.com/en/kb/articles/661081-how-do-i-edit-an-item-in-an-item-bank-in-new-quizzes), [Add all or random bank items](https://community.instructure.com/en/kb/articles/661082-how-do-i-add-all-items-or-a-random-set-from-an-item-bank-to-a-quiz-in-new-quizzes), [Move or copy bank items](https://community.instructure.com/en/kb/articles/661083-how-do-i-move-or-copy-an-item-to-an-item-bank-in-new-quizzes), [Share an Item Bank](https://community.instructure.com/en/kb/articles/661086-how-do-i-share-an-item-bank-in-new-quizzes), and [Manage Account Item Banks](https://community.instructure.com/en/kb/articles/661524-how-do-i-manage-account-item-banks-in-new-quizzes) describe Canvas instructor workflows.
- `docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md` records the ExamplePlatform source harvest for the private `/api/banks` routes and the separate quiz-builder bank-association route.
- `connector/extension/src/item-bank-executor.js` is Morrow's executable provider boundary. `scripts/test/canvas-item-bank-executor.test.mjs` proves the bank reads and proves, for every bank-management change, one dispatch, a verified readback, a stale-snapshot refusal, a definite provider refusal, an uncertain answer that is never repeated, and a saved result that does not match.

An official UI workflow does not prove a public API. A harvested private route does not prove that a Morrow-connected tenant accepts it. A successful write response does not prove the saved effect. Morrow requires authoritative readback.

## Common execution contract

All 18 Morrow Item Bank operations require a selected numeric `course_id`. Fourteen bank-management operations use a fresh credential captured from that course's exact `/external_tools/54065` launch. The credential includes the private `contextUuid`, stays inside the browser execution boundary, expires after ten minutes, and is bound to the exact tenant, tab, frame, launch, principal, and course. The numeric Canvas course id and the private context UUID are separate values. The quiz-entry read and bank-draw write use a separate assignment-bound New Quiz builder launch and `quiz.build_token`. Morrow derives the private quiz id from exactly one builder resource, verifies it with `GET /api/quizzes/{quiz_id}`, and keeps the builder credential inside that frame.

Every bank-specific request first walks the selected course's current bank list and requires the exact `bank_id`. A change adds four more steps in this order:

1. The reviewer's observed-reach disclosure is checked. Canvas has no account-wide list of every quiz that draws from a bank, so the disclosure never claims one; it names the courses Morrow observed, and the reviewer acknowledges exactly those courses.
2. Every digest the reviewer pinned is recomputed from a fresh read taken inside the Item Banks frame. A source Morrow cannot read, or state that moved, stops the change.
3. One request is sent. There is no second attempt. A 4xx other than 408 and 429 means Canvas refused it. A lost connection, 408, 429, and every 5xx leave the outcome unknown, and Morrow says so rather than sending it again.
4. Canvas is read again and the saved result is compared with the reviewed change. A change is reported as done only when that reread proves it.

## Current Morrow operations

| Capability | Tool and route | Required snapshot | Authoritative readback | Status |
| --- | --- | --- | --- | --- |
| List banks available in the selected course | `canvas_item_bank_list_banks`, `GET /api/banks?course_id={contextUuid}` | None | Sanitized bounded list plus `snapshotSha256` and paging state | Admitted read, live-unverified |
| Read one bank | `canvas_item_bank_get_bank`, `GET /api/banks/{bank_id}` | None | Exact bank object plus `snapshotSha256` | Admitted read, live-unverified |
| List entries | `canvas_item_bank_list_entries`, `GET /api/banks/{bank_id}/bank_entries` | None | Sanitized bounded list plus `snapshotSha256` and paging state | Admitted read, live-unverified |
| Read one entry | `canvas_item_bank_get_entry`, `GET /api/banks/{bank_id}/bank_entries/{bank_entry_id}` | None | Exact entry object plus `snapshotSha256` | Admitted read, live-unverified |
| Read one item | `canvas_item_bank_get_item`, `GET /api/banks/{bank_id}/items/{item_id}` | None | Exact item object plus `snapshotSha256` | Admitted read, live-unverified |
| List observed shares | `canvas_item_bank_list_shares`, one unpaged `GET /api/banks/{bank_id}/shared_banks` | None | Sanitized observed rows plus `snapshotSha256`, `truncated=true`, `paginationComplete=false`, and `paginationUnestablished=true` | Admitted incomplete read, live-unverified |
| Create bank | `canvas_item_bank_create_bank`, `POST /api/banks` | `banks_sha256` | Reread the new bank by the id Canvas returned, require the reviewed title and language, and require the bank in the selected course's fresh bank list | Available, live-unverified |
| Rename bank | `canvas_item_bank_rename_bank`, `PATCH /api/banks/{bank_id}` | `bank_sha256` | Reread the bank and require the reviewed title | Available, live-unverified |
| Delete or archive bank | `canvas_item_bank_archive_bank`, `DELETE /api/banks/{bank_id}` | `bank_sha256`, `entries_sha256`, `shares_sha256` | Require 404 from the exact bank read and absence from the selected course's fresh bank list | Available, live-unverified |
| Create standalone item | `canvas_item_bank_create_item`, `POST /api/banks/{bank_id}/items` | `bank_sha256` | Read the returned item id and require the complete reviewed payload as a subset | Available, live-unverified |
| Update item | `canvas_item_bank_update_item`, `PATCH /api/banks/{bank_id}/items/{item_id}` | `bank_sha256`, `item_sha256` | Reread the item and require the complete reviewed payload as a subset | Available, live-unverified |
| Attach existing item | `canvas_item_bank_attach_item`, `POST /api/banks/{bank_id}/bank_entries` | `bank_sha256`, `item_sha256`, `entries_sha256` | Read the returned entry id and require `entry_type=Item` plus the exact linked item id | Available, live-unverified |
| Remove entry association | `canvas_item_bank_delete_entry`, `DELETE /api/banks/{bank_id}/bank_entries/{bank_entry_id}` | `bank_sha256`, `entry_sha256`, `entries_sha256` | Require 404 from the exact entry read and absence from the bank entry list | Available, live-unverified |
| Share with one course | `canvas_item_bank_share_bank`, `POST /api/banks/{bank_id}/shared_banks` | `bank_sha256`, `shares_sha256` | Reread the share list and require the exact course read share; an existing identical share is refused instead of sent again | Available, live-unverified; the share list answers one unpaged request |
| List quiz entries and bank draws | `canvas_item_bank_list_quiz_draws`, numbered `GET /api/quizzes/{quiz_id}/quiz_entries?page={page}` calls through an empty end page | None | Complete sanitized quiz-entry list plus `snapshotSha256`; the private quiz id is derived from the exact assignment-bound builder; a page or row bound stops the read | Admitted read, live-unverified |
| Attach a random bank draw to one quiz | `canvas_item_bank_attach_bank_to_quiz`, `POST /api/quizzes/{quiz_id}/quiz_entries` | `bank_sha256`, `quiz_entries_sha256` | Reread the complete quiz-entry list and require exactly one new `Bank` row for the exact bank | Available, live-unverified |
| Attach one bank entry to one quiz | `canvas_item_bank_attach_bank_entry_to_quiz`, `POST /api/quizzes/{quiz_id}/quiz_entries` | `bank_sha256`, `entry_sha256`, `quiz_entries_sha256` | Reread the complete quiz-entry list and require exactly one new row for the exact bank entry | Available, live-unverified |
| Remove one quiz bank draw or entry | `canvas_item_bank_delete_quiz_bank_entry`, `DELETE /api/quizzes/{quiz_id}/quiz_entries/{quiz_entry_id}` | `bank_sha256`, `quiz_entries_sha256`, `quiz_entry_sha256` | Require absence of the exact row from a complete reread of the quiz-entry list | Available, live-unverified |

The required snapshots are operation-specific on purpose. A bank snapshot cannot substitute for an item snapshot. A list snapshot cannot substitute for one entry. Every digest the reviewer pinned is compared, not only the minimum set. `item_bank_snapshot_invalid`, `item_bank_snapshot_unreadable`, and `item_bank_snapshot_changed` all stop the change before Canvas receives it, and an uncertain outcome after dispatch never permits an automatic retry.

## Content, assessment, and remediation matrix

| Area | Current contract | Limit |
| --- | --- | --- |
| Question item body, feedback, interaction data, scoring data, and settings | Create and update carry the complete reviewed `item` object. An update never carries a partial field patch, and the saved question is reread and compared with the reviewed one. | The provider remains the schema authority for fields the private harvest does not type. |
| Choice or multiple choice | Local validation checks choice ids, bodies, scoring references, and embedded media. | Live provider acceptance is unverified. |
| Matching | Local validation checks question ids, scoring keys, match coverage, and embedded media. | Item Bank ids do not use the inline New Quiz `q-1` convention. |
| Numeric | Local validation checks numeric values, units, and dimensions. | Live provider acceptance is unverified. |
| Rich Fill in the Blank | Local validation checks blank ids, blank kinds, scoring rows, word bank membership, and body markers. | Live provider acceptance is unverified. |
| Other private Item Bank question types | The complete item passes through after general object and media checks. | Morrow does not claim an independently typed contract for every private type. Plan and readback still bind the entire object. |
| Rich content and media | A new question is refused if any image has no `alt` attribute, if media markup cannot be read, or if a media source is not an `https://` address, a `/courses/` path, or an `/api/v1/files/` path. A change to an existing question is judged against the question Canvas holds right now: it is refused only for a media problem the change would add. Repairing one image is never refused because a different image in the same question still needs work, and adding a second copy of an undescribed image is still refused. | `alt=""` is an explicit decorative decision and is accepted. Hot Spot media-byte upload is not implemented. |
| Focused accessibility repair | `morrow_audit_course` resolves an entry to its item. `morrow_plan_item_bank_question_image_alt_repair` fresh-reads course, bank, entry, and item, changes one selected missing `alt`, preserves all other item state, and produces a reviewable generic-update plan with exact bank and item snapshots. A question with several undescribed images is repaired one reviewed image at a time; the others are left exactly as Canvas holds them. | Stimulus entries, unresolved item ids, stale evidence, changed interaction ids, and unsupported item shapes fail closed. |
| Outcomes and tags | Complete item update can preserve provider-returned fields that already exist. | Morrow has no dedicated outcome-link, tag search, tag add, or tag remove operation. It does not invent these private shapes. |
| Points | Complete item create or update carries the reviewed provider item object, including saved scoring fields. | Morrow has no separate bulk points operation for a bank or a bank draw. |
| Ordering | Reads preserve provider entry order. | No private reorder route was established. Morrow has no bank or item ordering write. |

## Course association, ownership, sharing, and downstream use

The selected course is the authority frame and bank-association control. It does not prove that the bank belongs only to that course. Owner operations can affect a bank used elsewhere. Morrow exposes that effect for review, uses the exact current bank state as the write precondition, and does not treat an incomplete dependency scan as an empty set.

`morrow_read_item_bank_fan_out` reports entry counts, observed share rows, and New Quiz uses from selected connected courses. Current Canvas share rows identify courses by private context UUID, while Morrow's course bindings use numeric Canvas course ids. Morrow has no proved mapping between those values, so it does not claim a shared course identity from a share row. Canvas also exposes no authoritative account-wide reverse lookup from a bank to every consuming quiz. A bank owner can use a bank in an unselected course without a course-share row. The record therefore always stays `complete: false`, and a record that claims otherwise is refused.

That record is a required precondition for changing an existing bank, used as a disclosure rather than as a completeness claim. The reviewer must acknowledge the exact list of observed courses outside the selected one, in writing, and an empty list is still an explicit acknowledgement. A record that is missing, from another bank or course, edited after it was taken, older than one hour, or dated in the future stops the change before Canvas receives it.

Morrow defines one share shape: add read access for one Canvas course. It works, and the saved share is reread and required before Morrow reports it as done. User, account, and subaccount shares remain absent. Edit permission, share update, and share removal remain absent. Account Item Bank administration remains absent.

The share list is the one Item Bank read whose paging is unestablished. Attended provider proof has established only one unpaged `/shared_banks` response, with no page parameter, continuation signal, or end condition. Morrow reads it once, marks the result `paginationUnestablished`, and never treats an empty or short response as a complete share list. A bank with more shares than one response returns therefore has a share snapshot and a share readback that cover only what Canvas answered in that one response.

## Explicit gaps

| Capability | Status and exact reason |
| --- | --- |
| Duplicate bank | Absent. No exact private duplicate route and readback contract was established. |
| Delete standalone item object | Absent. `canvas_item_bank_delete_entry` removes only the bank association. |
| Create stimulus | Absent. The ExamplePlatform harvest contains no stimulus preservation contract. |
| Update stimulus | Absent. The ExamplePlatform harvest contains no stimulus preservation contract. |
| Delete stimulus | Absent. The ExamplePlatform harvest contains no stimulus preservation contract. |
| Manage stimulus dependencies | Absent. Morrow cannot prove every item that depends on a stimulus. |
| Move one item between banks | Absent as an atomic workflow. Combining attach and remove would create a two-step partial failure state without a recovery contract. |
| Copy one item between banks | Absent as an atomic workflow. The exact provider copy payload and copied-item readback were not established. |
| Bulk move | Absent. No exact bulk route, partial-failure settlement, and readback contract was established. |
| Bulk copy | Absent. The reviewed official workflow does not establish a bulk-copy contract. |
| Search tags | Absent. No exact private search route and normalized result contract was established. |
| Add tag | Absent. Complete-item update preserves tags it reads, but Morrow does not invent a tag-mutation shape. |
| Remove tag | Absent. Complete-item update preserves tags it reads, but Morrow does not invent a tag-mutation shape. |
| Search outcomes | Absent. No exact private search route and normalized result contract was established. |
| Link outcome | Absent. No exact private route and saved-link readback contract was established. |
| Unlink outcome | Absent. No exact private route and saved-link readback contract was established. |
| Provider text search | Absent. Morrow can filter a complete bounded read locally, but it does not claim Canvas UI search parity. |
| Provider type search | Absent. Morrow can filter a complete bounded read locally, but it does not claim Canvas UI search parity. |
| Bank-list search | Absent. No proved private request and normalized result contract was established for searching the bank index. |
| `Shared with Me` filter | Absent. The course launch and one unpaged share observation do not establish the Canvas UI filter contract. |
| `All Banks` filter | Absent. The course-context bank list does not prove an account-wide all-banks view. |
| `Institution Banks` filter | Absent. A course launch grants no account Item Bank administration contract. |
| `Banks Shared to Course` filter | Absent. No proved private filter distinguishes course shares from owner access or other bank visibility. |
| QTI import | Absent. No import job, scope, overwrite, and created-item reconciliation contract was established. |
| Direct Item Bank export | Absent. Canvas documents New Quiz and course export paths, but no direct Item Bank export. Morrow does not automate the indirect export workflow. |
| Share with a user | Absent. Morrow admits only course read-sharing. |
| Share with an account | Absent. Morrow admits only course read-sharing. |
| Share with a subaccount | Absent. Morrow admits only course read-sharing. |
| Grant edit access in a share | Absent. Morrow shares a bank with a course as read access only. |
| Change an existing share | Absent. No exact private route and effective-permission readback was established. |
| Remove an existing share | Absent. No exact private route and effective-permission readback was established. |
| List every account-level bank | Absent. A course launch does not grant account administration. |
| Create an account-level bank | Absent. A course launch does not grant account administration. |
| Administer account-level banks | Absent. A course launch does not grant account administration. |
| Add one bank item to a quiz | Available as a bank-entry draw. `canvas_item_bank_attach_bank_entry_to_quiz` adds one exact bank entry to one exact New Quiz. Copying a bank item into a quiz as a standalone question is absent: the public New Quiz item create contract does not define a bank-copy source. |
| Add all items to a quiz without a random count | Absent. The proven builder payload establishes a `Bank` random draw through `properties.sample_num`; it does not establish a separate all-items mode. |
| Update an existing random bank draw | Absent. Creation and removal both work; changing an existing draw in place has no proved route and no exact readback. |
| Remove an existing random bank draw | Available. `canvas_item_bank_delete_quiz_bank_entry` requires the exact row and proves its absence from a complete reread of the quiz-entry list. |
| Reorder banks | Absent. No proven route. |
| Reorder items inside a bank | Absent. No proven route. |
| Bulk-change item points | Absent. Complete-item create and update can carry reviewed scoring fields for one item, but no bulk operation exists. |
| Change points on an existing bank draw | Absent. Adding a draw carries points per item; changing an existing draw in place is not implemented. Remove the draw and add it again. |

## Completion and proof

The catalog contains 18 Item Bank operations: seven reads and eleven course-bound changes. All of them are available. The focused alternative-text planner uses the same reviewed item-update shape as any other question change and carries the same snapshots and the same observed-reach acknowledgement. No private Item Bank or builder credential, and no private context UUID, crosses the browser boundary in any result.

Local proof covers all seven reads and, for each of the nine bank-management change shapes (the eight `/api/banks` changes and the guarded alternative-text repair), a happy path with exactly one dispatch and a verified reread, a stale-snapshot refusal with no dispatch, a definite provider refusal, an uncertain provider answer that is never sent twice, and a saved result that does not match and is never reported as done. It also covers wrong course, wrong signed-in person, wrong frame, wrong launch, an expired credential, a bank the selected course does not hold, an unsupported share scope, paged quiz-entry reads, and UUID share-identity refusal.

Local proof does not prove that a specific Canvas tenant accepts the private routes. Run `docs/implementation/ITEM-BANK-LIVE-PROOF-PLAN.md` for attended live proof. This audit made no live provider write.
