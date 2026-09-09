# Canvas New Quizzes completion matrix

Date: 2026-09-08. Revised 2026-09-08 after the New Quizzes gap-closing pass.

This matrix separates provider support from Morrow support. `Admitted` means the operation has a course-bound request, review and dispatch path, and an authoritative post-write check. `Held` means Morrow exposes no send path. `Read only` means Canvas documents a read but no matching write. All write tests in this audit used local fixtures. No Canvas write was sent.

## Quiz lifecycle and course placement

| Requirement | Canvas contract | Morrow state | Contract and evidence |
|---|---|---|---|
| Create a New Quiz | `POST /api/quiz/v1/courses/:course_id/quizzes` | Admitted, live-unverified | `morrow_plan_new_quiz_create` validates every supplied official field and setting and freezes the complete quiz membership. The Bridge sends once, requires exactly one added ID, reads that exact quiz, and compares every requested field. The same complete-list and exact-quiz reconciliation survives a gateway restart. |
| Read and list | GET one and list routes | Read only | `canvas_get_new_quiz`, `canvas_list_new_quizzes`; bounded browser pagination; exact decimal IDs. |
| Update quiz metadata | `PATCH` one New Quiz | Admitted, live-unverified | `canvas_update_single_quiz`; exact `canvas_get_new_quiz` readback compares supplied title, instructions, assignment group, points, dates, grading type, and settings leaves. |
| Delete | `DELETE` one New Quiz | Admitted only with no student work, live-unverified | `morrow_plan_new_quiz_delete` freezes the complete quiz list, full quiz, complete item records, and linked Assignment. Canvas must explicitly report both `has_submitted_submissions=false` and `graded_submissions_exist=false`. The Bridge rereads every snapshot immediately before one delete and verifies exact absence from the complete quiz list. |
| Duplicate | `POST /api/v1/courses/:course_id/assignments/:assignment_id/duplicate`. The only documented parameter is `result_type`, whose only allowed value is `Quiz`; the route otherwise "Returns an Assignment object" | Held | `canvas_duplicate_assignment` still carries `duplicate_assignment_exact_readback_unavailable`. Checked against the Canvas Assignment resource on 8 September 2026 before deciding. The response shape is not the blocker and the hold reason no longer says it is: with `result_type` omitted, "the response will be serialized into an assignment format" and the route "Returns an Assignment object". Two documented facts do block it. Canvas documents no field on the copy that names it a New Quiz: the Assignment object documents `is_quiz_assignment`, whose name and description disagree with each other, and documents no `is_quiz_lti_assignment` at all, so the derived readback above cannot be bound to anything. And Canvas documents no signal that the copy has finished: `workflow_state` is documented only as "String indicating what state this assignment is in", with `unpublished` as its one example value, so a reread taken straight after the request could describe a half-made copy. The hold stands and its sentence now names those two facts. `scripts/test/canvas-verification.test.mjs` pins both, and pins that the retired "different record types" belief cannot come back. |
| Publish or unpublish | The linked Assignment owns `published` | Admitted through Assignment edit, live-unverified | New Quiz ID is its assignment ID. `canvas_edit_assignment` writes `assignment[published]`; `canvas_get_single_assignment` verifies the exact assignment and state. Provider rules can reject unpublish after attempts. |
| Assignment linkage | New Quiz routes use the assignment ID | Admitted | Planner and executor bind `quiz_id` to `assignment_id`; fresh course and New Quiz reads reject a wrong course or quiz. |
| Add to a module | `POST /api/v1/courses/:course_id/modules/:module_id/items` with `module_item[type]` and `module_item[content_id]` | Admitted, live-unverified | `morrow_plan_new_quiz_module_placement` proves the target is a New Quiz by requiring the exact New Quiz read and the exact Assignment read to return the same id in the same course and Canvas to report `is_quiz_lti_assignment: true`. It freezes the module's complete item list, refuses a module that already holds the quiz and a position past the end, and sends `module_item[type]=Assignment` with `module_item[content_id]` equal to the New Quiz id. The catalog readback reads the created module item and requires that exact `type`, `content_id` and `position`. |
| Move within or between modules | `PUT /api/v1/courses/:course_id/modules/:module_id/items/:id` with `module_item[position]` and `module_item[module_id]` | Admitted, live-unverified | `morrow_plan_new_quiz_module_move` reads the exact module item and sends nothing unless Canvas reports `type: "Assignment"` and a `content_id` equal to the New Quiz id. That is the missing proof: a `Quiz` module item names a Classic Quiz in a different id space, so it is refused even when its `content_id` matches. Morrow freezes the complete item list of the current module and of the target module, refuses a target that already holds the quiz, and verifies the moved item's own saved module, position, type and content id. |
| Order quizzes in an assignment group | `PUT /api/v1/courses/:course_id/assignments/:id` with `assignment[position]` | Admitted, live-unverified | A New Quiz is ordered in its group as the Assignment it is. `morrow_plan_new_quiz_assignment_group_order` uses the same New Quiz proof, reads the complete assignment list of the quiz's own `assignment_group_id`, refuses a quiz absent from that list and a position past its end, and verifies the quiz's own saved position with an exact Assignment read. `canvas_reorder_quiz_items` remains a Classic Quiz route and is not used. |

## Quiz settings

All settings changes use `morrow_plan_new_quiz_settings`. The planner reads the complete saved `quiz_settings` block, validates the requested values, merges omitted values, freezes the current digest, and creates one reviewed operation. The Bridge rereads the block immediately before dispatch and refuses stale state. It sends the complete merged block and rereads the complete block afterwards. Evidence: `packages/mcp-server/src/new-quiz-settings.ts`, `connector/extension/src/new-quiz-write-contract.js`, and `connector/extension/src/canvas-content.js`.

| Requirement | State | Enforced contract |
|---|---|---|
| Points | Admitted on create and on update | `morrow_plan_new_quiz_create` validates `points_possible` as a number greater than 0 and sends it with the reviewed create; `canvas_create_new_quiz` is admitted and its readback is the exact created-quiz read. An update uses the same rule with an exact quiz readback. |
| Due, unlock, and lock dates | Admitted | Canvas DateTime fields. Exact quiz readback. Provider enforces date ordering. |
| Multiple attempts | Admitted | Booleans; positive `max_attempts`; `score_to_keep` is `average`, `first`, `highest`, or `latest`; attempt-dependent fields require multiple attempts enabled. |
| Cooling period | Admitted | Positive seconds and enabled cooling period; requires multiple attempts. |
| Time limit | Admitted | Positive whole seconds or null; a non-null limit requires `has_time_limit`. |
| Access code | Admitted | Text or null; a non-null code requires `require_student_access_code`; an enabled code cannot be empty. |
| One question at a time and backtracking | Admitted | `one_at_a_time_type` is `none` or `question`; backtracking can be true only for `question`. |
| Calculator | Admitted | `none`, `basic`, `scientific`, or null. |
| Shuffle answers and questions | Admitted | Boolean values. |
| IP filter | Admitted | Valid IPv4 or IPv6 start/end pairs or null; active ranges require `filter_ip_address`. |
| Result visibility and feedback | Admitted | Official response and correctness qualifier enums; RFC 3339 show/hide times; item, response, correctness, point, answer, and feedback fields require their documented parent flags. |
| Course and quiz accommodations | Admitted as response-bound effects, live-unverified | `morrow_plan_new_quiz_accommodation` accepts only a course-local `Student A1` label. The trusted gateway resolves the Canvas user ID from a fresh complete current and deleted roster at dispatch. The Bridge sends one exact JSON array and requires one matching success row and no failure row. Raw learner identifiers are redacted from success and failure output. Canvas has no accommodation GET, so a lost response stays ambiguous and is never retried. |
| Quiz reports | Admitted as Progress-bound requests, live-unverified | `morrow_plan_new_quiz_report` validates the official type and format. The response must be an exact Assignment-bound Progress record with its matching `/api/v1/progress/:id` URL. A completed receipt must also contain a same-origin API artifact URL. The official Progress GET tool provides the durable follow-up read. A lost create response stays ambiguous because no Progress ID exists to query. |
| Outcome alignment | Unsupported by the New Quizzes item contract | No write tool | Canvas Outcome APIs manage course or account outcomes, but current New Quizzes docs expose no item alignment write. Morrow does not infer one. |

## Item lifecycle and question types

All twelve creatable New Quiz question types can now be created. Hot Spot was the last one held, and its reviewed media-upload chain is built and wired end to end.

Question create and replacement use `morrow_plan_new_quiz_item_create` and `morrow_plan_new_quiz_item_replacement`. The planner requires `entry_type` exactly `Item`, positive points, a supported question payload, and a complete saved membership list. The lifecycle guard freezes every listed row's ID, position, and entry type. A quiz can contain Stimulus, BankItem, or BankEntry rows; the planner still refuses one of those rows as the direct target. Replacement is a reviewed delete followed by create. It preserves author-controlled fields and drops the provider-assigned fields Canvas returns on every saved question, which the documented objects name: the QuizItem's `status`, `entry_editable`, `stimulus_quiz_entry_id` and `properties`, and the QuestionItem's `id`, `created_at` and `updated_at`. A container Canvas returned as null, such as the documented `"feedback": null`, carries no leaf and is dropped; a Required create field returned as null is never dropped and is refused loudly by the question contract. The caller rule is unchanged and separate: a caller who supplies any provider-assigned field, or a null container, is refused, because a null container is ambiguous between "no feedback" and "clear the feedback". Replacement also refuses a stimulus relationship, a provider status other than exact `mutable`, a provider lock, and an unrecognized current field the create route cannot preserve. Delete uses `morrow_plan_new_quiz_item_delete`, freezes the complete target item digest, and treats an already absent item as complete without a write.

### Reviewing a quiz, including the questions it takes from a bank

`morrow_check_new_quiz` reviews the questions a quiz actually uses. The documented `QuizItem` carries bank content inside the row: a `BankEntry` row's `entry` is a `BankEntryItem` holding its `bank_id`, whether it holds an `Item` or a `Stimulus`, and that record itself, so the review checks that question with the others and no Item Bank credential is needed. A `Bank` row's `entry` is a `BankItem` holding the bank id, title, `entry_count` and `item_entry_count`, and its `properties.sample_num` is "the number of items to randomly select from the bank. null if all items should be included". The review therefore reports the exact number of questions a draw supplies, including the all-items case, multiplies it by the row's points per question, and reads the named bank through the admitted Item Bank reads to check every question that draw can supply. Canvas decides which of them a learner receives at attempt time and publishes no list of the selected ones, so the complete bank is the honest answer. Counts, points and repeated-content checks now include bank-backed content. A bank Morrow cannot read is named in `incomplete` with the exact reason; it is never reported as an empty bank or as a quiz with no questions. Totals completeness and content completeness are reported separately, so a count check still runs when only the bank questions were unreadable.

| Item or question type | Morrow build state | Notes |
|---|---|---|
| Multiple Answer (`multi-answer`) | Admitted, live-unverified | Exact choice UUIDs, scoring references, algorithm, properties, feedback, and media checks. |
| Matching (`matching`) | Admitted, live-unverified | Exact question and answer references, algorithm, shuffle properties, and media checks. |
| Categorization (`categorization`) | Admitted, live-unverified | Exact category, distractor, and answer UUIDs; order and shuffle properties. |
| File Upload (`file-upload`) | Admitted, live-unverified | Student response upload type. It does not upload author media. |
| Formula (`formula`) | Admitted, live-unverified | Formula variables, answer precision, scoring algorithm, and media checks. |
| Ordering (`ordering`) | Admitted, live-unverified | Exact keyed choice UUIDs, labels, paragraph and shuffle properties, and scoring order. |
| Rich Fill in the Blank (`rich-fill-blank`) | Admitted, live-unverified | Exact blank and choice UUIDs, scoring methods and references. Deprecated `fill-blank` create is refused. |
| Hot Spot (`hot-spot`) | Admitted through the reviewed media chain, live-unverified | The complete upload chain is built. `morrow_plan_new_quiz_item_create` routes any Hot Spot to `GatewayRuntime.planCanvasNewQuizHotSpotCreate`, which reads the course, quiz and complete membership, refuses a question that carries its own `image_url`, derives the content type from the file name and checks it against the file's own leading bytes, stages the reviewed image privately in the file-stage store bound to that operation, rereads the connection scope and refuses a scope that moved during preparation, and freezes `before_items_sha256` and `payload_sha256`. Dispatch is one private approval-bound operation, `canvas_create_new_quiz_hot_spot` / `canvas.private.new_quiz.hot_spot.create.v1`: the page reads `GET /api/quiz/v1/courses/:course_id/quizzes/:assignment_id/items/media_upload_url` and rechecks the frozen membership digest, the worker sends the exact staged bytes once with a single `PUT` under a `chrome.webRequest` confirmation observer after rechecking their size and SHA-256, and only a 2xx observed upload allows the item create. The create sends the reviewed payload with `entry.interaction_data.image_url` set to that upload URL with its query string and fragment removed, which is what Canvas documents ("the query params present on the signed url are not included here"). The page rechecks the payload digest and the request deadline immediately before that one POST. Readback rereads the created item by the id Canvas returned and rereads the complete membership; only both matching is `verified`. A refused upload is reported and never repeated on its own, and an uncertain create is `outcomeUnknown` and never retried. Evidence: `packages/mcp-server/src/canvas-new-quiz-hot-spot.ts`, `connector/extension/src/canvas-new-quiz-hot-spot.js`, `executeCanvasNewQuizHotSpotCreate` in `connector/extension/src/service-worker.js`. |
| Multiple Choice (`choice`) | Admitted, live-unverified | Exact choice UUIDs, scoring mode, answer feedback map, shuffle properties, and media checks. |
| Numeric (`numeric`) | Admitted, live-unverified | Numeric scoring methods and values. |
| True or False (`true-false`) | Admitted, live-unverified | Exact scoring value and equivalence algorithm. |
| Essay (`essay`) | Admitted, live-unverified | Non-autoscored response contract and media checks. |
| Stimulus or text block | Read only, and this is the whole truth about it | `item[entry_type]` on both create and update has one allowed value, `Item`. The New Quiz Items API says of stimulus items: "For now, stimulus items can only be retrieved with the API. They must be created and updated via the UI." A text block is a `StimulusItem` with `passage: true`, so the same sentence governs it. Canvas publishes no other route, and the harvested private builder contract carries no stimulus write and no stimulus preservation rule. Morrow reads these rows, reports their bodies, and refuses them as a create, update, replacement or delete target. That sentence, not a hedge, is what the product says. |
| `Bank` draw and `BankEntry` row | Membership read with content, plus builder create and delete | The official New Quiz item write accepts only the `Item` entry type, and Canvas says the same about bank items: "For now, bank items can only be retrieved with the API. They must be created and updated via the UI." Morrow therefore writes these rows through the assignment-bound quiz builder instead. It can add a random draw, add every item in a bank, add one bank entry, and remove any of them. It cannot change an existing draw in place. |
| Item points | Admitted | Positive number; exact item readback. |
| Item position and full order | Admitted only with full-list guard | The order planner requires an exact permutation of a complete list containing only `Item` rows. Each position is a positive integer and each write carries the exact current and expected list digests. The Bridge refuses Stimulus or BankEntry rows, incomplete or stale membership, and verifies the full list after each move. |
| Answer, choice, and feedback edit | Admitted with complete-item merge and strict validation | The Bridge rereads the complete item and requires exact `mutable` status, no provider lock, and no stimulus relationship. It merges the requested patch, validates the complete result with the same all-type contract used by the lifecycle planner, and preserves every provider interaction UUID. Position-only changes use the same target gate and also require the full-order guard. A combined move and content edit reads the target item once. Structural edits that change interaction ID membership use the governed replacement planner. Focused alternative-text repair tools remain the narrow accessibility workflow. |

### Live-unverified note: the Hot Spot media chain

Added by the lane that built the chain. These three facts about Canvas are the
ones no local test can settle, because each is a property of a live Canvas
tenant and of the storage host Canvas signs the upload URL for. The chain is
complete and its refusals are proved against fixtures; what follows is what a
first live run has to confirm, and what happens if Canvas differs.

1. **The media upload response may carry more than the one field Morrow reads.**
   Morrow reads `url` from
   `GET /api/quiz/v1/courses/:course_id/quizzes/:assignment_id/items/media_upload_url`
   and nothing else. Canvas documents that one field. If a live tenant also
   returns fields the upload requires, such as headers to set, form parts to
   send, or a lifetime the caller has to honour, Morrow does not read them and
   the upload would be sent without them.

2. **The upload host may not answer a cross-origin `PUT` in a way the page can
   read.** Canvas signs a URL on a storage host, not on the Canvas origin. If
   that host sends no CORS headers, the `fetch` response is opaque or fails
   outright, and its status is not readable from the response. Morrow therefore
   watches that exact request with a `chrome.webRequest` observer and takes the
   status from there. That observer is the part of the chain that no fixture can
   prove, because it needs a real cross-origin response.

3. **Canvas may not save the image URL exactly as Morrow sends it.** Morrow
   sends the signed upload URL with its query string and fragment removed, which
   is what Canvas documents. If Canvas normalises, rewrites, or re-signs that
   URL when it saves the question, the saved value will not equal the value
   Morrow sent.

What each would look like, so nobody reads a refusal as a defect in the wrong
place: 1 shows as a refused or uncertain upload before any question is created;
2 shows as `canvas_hot_spot_upload_refused` or an uncertain outcome, again with
no question created; 3 shows as `canvas_hot_spot_item_readback_mismatch` after
the question was created, which means the question exists and Morrow will not
say it is verified. None of the three can create a second question, because the
create is sent once and an uncertain result is never retried.

## Item Bank content in a quiz

Every one of these uses the assignment-bound New Quiz builder launch and its `quiz.build_token`. The credential never leaves that frame. The private quiz id is derived from exactly one builder resource and confirmed with `GET /api/quizzes/{quiz_id}` before anything else happens. Each write freezes the complete quiz-entry list and the exact bank snapshot, sends once, and verifies against a fresh complete re-list.

| Requirement | Morrow state | Contract and evidence |
|---|---|---|
| List the bank draws and bank entries in a quiz | Admitted read, live-unverified | `canvas_item_bank_list_quiz_draws` walks numbered pages to an empty end page and returns the complete sanitized list with `snapshotSha256`. |
| Add a random draw from a bank | Admitted, live-unverified | `canvas_item_bank_attach_bank_to_quiz` sends one `Bank` quiz entry with the exact bank id, `properties.sample_num` equal to the requested count, points per question, and position. The readback requires exactly one new row matching all of them. |
| Add every item in a bank | Admitted, live-unverified | The same operation with no `pick_count`. `ItemProperties.sample_num` is documented as "the number of items to randomly select from the bank. null if all items should be included", so Morrow sends `properties: { sample_num: null }` and the readback requires that exact saved null. A saved numbered sample is a mismatch, not a pass. |
| Add one exact bank entry | Admitted, live-unverified | `canvas_item_bank_attach_bank_entry_to_quiz` sends one `BankEntry` quiz entry bound to the exact bank entry id, points, and position, after the bank entry's own snapshot is verified. |
| Remove a draw or a bank entry row | Admitted, live-unverified | `canvas_item_bank_delete_quiz_bank_entry` binds the exact row in the frozen complete list, checks its own digest, refuses a row whose bank or bank entry does not match, sends one DELETE, and requires exact absence from a fresh complete list. |
| Change an existing draw's sample count, points, or position | Absent | Canvas documents no update route for a quiz entry: the New Quiz Items API has no quiz-entry write at all, and the harvested private builder contract records `GET`, `POST` and `DELETE` on `/api/quizzes/{quiz_id}/quiz_entries` and no `PATCH` or `PUT`. Morrow will not compose a delete and a create into an "update", because that is two dispatches and an interrupted sequence would leave the quiz without the draw. Removing the row and adding the wanted one are two separately reviewed changes. |

## Dispatch, recovery, and evidence

| Requirement | State | Evidence |
|---|---|---|
| Exact course binding | Enforced | Course path ID, source binding, signed-in principal, current tab course, and fresh course read are checked before dispatch. A mismatch sends nothing. |
| Review boundary | Enforced | Planners are read-only. Their operations enter the normal review and approval journal. Planning sends and schedules nothing. |
| One application dispatch | Enforced | The operation journal reserves one dispatch. The Bridge also keeps a bounded replay record. Browser-native POST replay remains a documented provider transport risk. |
| Definite failure | Enforced | HTTP 4xx other than 408 and 429 is `outcomeUnknown: false`. The provider refused the request. |
| Uncertain result | Enforced | Network or parse failure, HTTP 408, 429, or 5xx is `outcomeUnknown: true`. Morrow does not repeat the write. |
| Bank draw recovery after a restart | Enforced | The Bridge keeps a durable assignment-bound recovery descriptor for every builder quiz-entry write: `attach_bank_to_quiz` and `attach_bank_entry_to_quiz` use `collection-contains-target` against `canvas_item_bank_list_quiz_draws` with the exact entry type, bank or bank-entry id, position, points and sample number, and `delete_quiz_bank_entry` uses `collection-omits-target` against the same read. The earlier hold for missing durable recovery no longer describes the code. |
| Lost-response recovery | Enforced for admitted exact-readback operations | The retained read-only comparator runs against the same source, course, and target. For settings changes, it rereads the complete `quiz_settings` block after a network exception, HTTP 408, HTTP 429, or HTTP 5xx response. Only an exact match settles the change as verified. An exact match to the pre-write block reports no effect. Any other mismatch or unreadable result remains ambiguous. Morrow does not repeat any of these writes. Creates use the provider-returned ID where available; unresolved duplicate risk is reported rather than deleted. |
| Local proof | Complete for the listed contract | Focused MCP, catalog, executor, readback, failure-classification, privacy, and recovery tests cover lifecycle planning, exact 18-digit IDs, restart recovery, destructive Assignment snapshots, both accommodation array routes, Progress reports, settings, all twelve creatable question types including the Hot Spot media chain, item lifecycle, replacement of a question in the complete documented saved shape, reorder, bank-backed quiz review, the four builder quiz-entry operations including the all-items draw, and New Quiz module placement, module move, and assignment-group order. The combined conformance harness exercises the final catalog without a live LMS write. |
| Live Canvas proof | Incomplete | No New Quiz lifecycle, setting, accommodation, report, item, bank, replacement, or reorder write was sent during this audit. Provider acceptance remains live-unverified. |

## Authoritative provider sources

- [New Quizzes](https://developerdocs.instructure.com/services/canvas/resources/new_quizzes)
- [New Quiz Items](https://developerdocs.instructure.com/services/canvas/resources/new_quiz_items)
- [New Quizzes Accommodations](https://developerdocs.instructure.com/services/canvas/resources/new_quizzes_accommodations)
- [New Quizzes Reports](https://developerdocs.instructure.com/services/canvas/resources/new_quizzes_reports)
- [Assignments](https://developerdocs.instructure.com/services/canvas/resources/assignments)
- [Modules](https://developerdocs.instructure.com/services/canvas/resources/modules)
- [Outcomes](https://developerdocs.instructure.com/services/canvas/resources/outcomes)
