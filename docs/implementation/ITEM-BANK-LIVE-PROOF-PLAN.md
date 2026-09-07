# Item Banks live proof plan

Written 7 September 2026. Nothing in this plan can be done on the machine that wrote it. It needs a person at a signed-in Chrome profile, a Canvas course with Item Banks permissions, and a disposable item bank.

Everything Morrow states about Canvas Item Banks is built from a contract Morrow wrote down and then tested against fixtures Morrow itself defined. No Morrow-connected Canvas tenant has answered `/api/banks`. `scripts/test/canvas-item-bank-executor.test.mjs`, `scripts/test/canvas-item-bank-frames.test.mjs`, `scripts/test/canvas-item-bank-guard.test.mjs` and `scripts/test/canvas-item-bank-fan-out.test.mjs` prove that the executor, the frame filter, the guard and the fan-out record agree with each other and with those fixtures. They are not evidence about Canvas. Until step 1 below is done, every Item Bank capability claim in this repository is live-unverified, and only the observations below can change that.

The harvested provider contract these steps check is [CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md](../research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md).

## What you need

- A signed-in Chrome profile with Morrow Bridge installed and paired, and one connected client. Confirm the connection with `morrow_canvas_connector_health`, then take the binding's `sourceBindingId` from `morrow_canvas_bindings`. Every tool below takes it as `source_binding_id`.
- A Canvas course whose Item Banks page you can open. The harvested contract names three role permissions: `Item Banks - manage account`, `Item Banks - share with subaccounts`, and `Question banks - view and link`. A role check is not an access check; the credential still has to exist in the frame.
- A disposable item bank that no course teaches from, holding at least one question whose body has an `<img>` with no `alt` attribute. Step 4 changes that question.
- A second course to share the disposable bank into for step 3.
- One uninterrupted sitting. Steps 3 and 4 run against a one-hour freshness limit, so they belong together.

## Recording rules

- Write records under `output/live-item-bank/`, which git ignores: `01-frame.json`, `02-reads.json`, `03-fan-out.json`, `04-write.json`, `05-uncertain.json`, and one `REPORT.md` naming the date, the Canvas host, the course id, the bank id, and the answer to each step.
- Never write the `banks.build` credential anywhere: not its value, not a digest of it, not a prefix of it. Its length and its presence are the only facts about it that go into a record.
- Redact `launch_token`, `access_token`, `token`, `jwt`, `signature` and `oauth_signature` from every URL you record. The step 1 snippet does this for you.
- From `current_user`, record the id only. Never the name or the email.
- Record storage key **names**, never their values, except `item_banks_scope` and `backend_url`, which the executor reads and which carry no credential.
- Where the answer is "I could not tell", write that. An unread answer is not a negative answer, and this record is worth nothing if it guesses.

## Step 1 — Frame observation

This single observation confirms or refutes Morrow's whole storage contract, which is `connector/extension/src/item-bank-executor.js:12-44`. Do it before anything else, and stop if it refutes the contract: steps 2 to 4 cannot run through a frame Morrow cannot enter.

1. Open the course in the signed-in profile and go to its Item Banks page. Canvas serves it at `/courses/{course_id}/item_banks`; if that path does not open, reach it from the course navigation. Record the exact URL you land on.
2. Open DevTools. In the console's context selector, look for a frame on a `quiz-lti` host. Record every frame the selector lists, by host.
3. With that frame selected, run this read-only snippet and save its result as `01-frame.json`.

```js
(() => {
  const REDACT = ["launch_token", "access_token", "token", "jwt", "signature", "oauth_signature"];
  const safeUrl = (value) => {
    try {
      const url = new URL(value);
      for (const name of REDACT) if (url.searchParams.has(name)) url.searchParams.set(name, "[redacted]");
      return url.toString();
    } catch { return value === "" ? "" : "[unreadable]"; }
  };
  const keys = (store) => { try { return Object.keys(store).sort(); } catch { return "unreadable"; } };
  const item = (key) => { try { return sessionStorage.getItem(key) ?? localStorage.getItem(key); } catch { return null; } };
  // The executor reads the credential from sessionStorage alone, so the two
  // stores are recorded apart. A token in localStorage would refute the
  // contract, not satisfy it.
  const token = (() => { try { return sessionStorage.getItem("banks.build_token"); } catch { return null; } })();
  const localToken = (() => { try { return typeof localStorage.getItem("banks.build_token") === "string"; } catch { return false; } })();
  const user = (() => { try { return JSON.parse(item("current_user") || "null"); } catch { return null; } })();
  return {
    observed_at: new Date().toISOString(),
    frame_url: safeUrl(location.href),
    frame_host: location.hostname,
    referrer: safeUrl(document.referrer || ""),
    session_storage_keys: keys(sessionStorage),
    local_storage_keys: keys(localStorage),
    banks_build_token_in_session_storage: typeof token === "string" && token.length > 0,
    banks_build_token_length: typeof token === "string" ? token.length : 0,
    banks_build_token_in_local_storage: localToken,
    item_banks_scope: item("item_banks_scope"),
    backend_url: item("backend_url"),
    current_user_id: user?.current_user?.id ?? user?.id ?? globalThis.ENV?.current_user_id ?? null,
  };
})()
```

4. Then start the lifetime check in the same frame, leave the tab alone, and record the last line it printed and whether the frame's console context disappeared.

```js
const started = Date.now();
let first = null;
let changed = false;
const timer = setInterval(() => {
  const token = sessionStorage.getItem("banks.build_token") || "";
  if (first === null) first = token; else if (token !== first) changed = true;
  console.log(`${Math.round((Date.now() - started) / 1000)}s present=${token.length > 0} length=${token.length} changed=${changed}`);
}, 5000);
// clearInterval(timer) after two minutes.
```

The frame host pattern Morrow injects into is `ITEM_BANK_FRAME_HOST_PATTERN` in `connector/extension/src/item-bank-frames.js`: one label, then `.quiz-lti` or `.quiz-api` with optional suffixes, then `.instructure.com`, over https only.

| Record | What depends on it | If it comes back different |
| --- | --- | --- |
| Whether a frame on a `quiz-lti` host exists, and its exact host | `ITEM_BANK_FRAME_HOST_PATTERN`; `connector/extension/src/service-worker.js` injects into matching frames alone | No matching frame means every Item Bank operation answers `item_bank_context_not_established`. Record the real host. The pattern has to change before any other step can run. |
| Whether more than one frame matches | The service worker executes only when exactly one frame answers `matched: true`, and otherwise answers `item_bank_context_ambiguous` | Record every matching host. Ambiguity is a refusal, not a failure, and the selection rule needs the real frame set before it can be narrowed. |
| Whether `sessionStorage` holds `banks.build_token`, and its length | `connector/extension/src/item-bank-executor.js:12-13`, which requires 51 to 8192 characters | This is the refutation to watch for. If the token is absent, or under another key, or outside that length, record the exact key names the frame holds. ExamplePlatform takes this credential from the `/api/sdk_tokens/banks.build` network response instead, which Morrow's boundary does not allow, so the executor's credential source has to be redesigned before steps 2 to 4 mean anything. |
| Whether `item_banks_scope` exists, and which of `course_id`, `courseId`, `context_id`, `contextId` it carries | `connector/extension/src/item-bank-executor.js:36-44`, which builds the course claim from this value and from the referrer path | If neither source names a course, the claim cannot be built and every operation answers `matched: false`. Record the whole value; it carries no credential. |
| `document.referrer` | `connector/extension/src/item-bank-executor.js:24-32`, which requires its origin to equal the bound Canvas origin over https | An empty or cross-origin referrer refuses every operation. Record what it actually is. |
| `current_user` in storage, or `ENV.current_user_id` | `connector/extension/src/item-bank-executor.js:9-11`, which requires the id to equal the connected principal | Record the id only. |
| `backend_url`, when the frame host itself does not match | `connector/extension/src/item-bank-executor.js:14-23`, the fallback that derives the API host | Record whether it exists and what host it names. |
| Whether the frame is still there after 30 seconds and after 2 minutes, and whether the token value changed | The contract's 3.1: Canvas's own router often collapses this frame seconds after a successful launch | A frame that collapses before a request means nothing was sent. One that collapses after a change was sent leaves the result uncertain, never failed. Record the elapsed seconds at the last printed line. |

Write the verdict in one sentence in `REPORT.md`: the storage contract at `item-bank-executor.js:12-44` is confirmed, or it is refuted and here is what the frame actually holds.

## Step 2 — Read proof

Six reads against one real bank in the selected course, through the connected client. Record the HTTP status, the top-level shape, the field names of one row or object, and the exact refusal string if the read does not answer. Save everything as `02-reads.json`.

| Read | Call | Record |
| --- | --- | --- |
| `canvas_item_bank_list_banks` | `course_id` of the selected course | Whether the result is an array; the field names on one bank row; `pageCount` and `truncated` from the result; whether every bank listed is one the selected course can use. |
| `canvas_item_bank_get_bank` | the chosen `bank_id` | The field names of a bank object, and whether any of them names a course or an account. This is the evidence for whether a bank has a course of its own. |
| `canvas_item_bank_list_entries` | `bank_id` | Whether a row carries its own `id` **and** an `entry_id` pointing at the item; the `entry_type` values seen; whether the row embeds the item under `item`, `entry`, `current_version` or `data`, or carries `item_body` and `interaction_data` itself, or carries none of these; `pageCount` and `truncated`. |
| `canvas_item_bank_get_entry` | `bank_id`, `bank_entry_id` | Whether the whole entry carries the item when the list row did not. The contract's 3.3 says a list row is not an item; record whether that holds here. |
| `canvas_item_bank_get_item` | `bank_id`, `item_id` taken from the entry's `entry_id` | Whether this route exists at all, and the field names of the item object, including whether `entry.item_body` and `entry.interaction_data` sit where Morrow reads them. A 404 here is a blocking result: this read is the comparator the guarded write in step 4 verifies against, so record it and stop before step 4. |
| `canvas_item_bank_list_shares` | `bank_id`, `per_page: 100` | The row count; whether a row spells the entity type `entity_type` or `entityType`; whether it carries an exact `entity_id`. Then ask for `page: 2` and record whether it returns more rows, repeats page 1, or errors. That answer settles whether `shared_banks` paginates, which no source in the harvest establishes. |

Record any refusal exactly as it comes back. `item_bank_context_not_established`, `item_bank_context_ambiguous`, `item_bank_course_mismatch`, `item_bank_path_refused` and `item_bank_response_too_large` each mean something different, and a paraphrase loses it. If a read answers `item_bank_context_not_established` partway through, the frame is gone: record which read it was and how long the frame had lived, reopen the Item Banks page, and carry on. How often that is needed is itself a result worth writing down.

## Step 3 — Fan-out proof

The guarded repair in step 4 refuses without a complete affected-course record, so this step establishes one.

1. In Canvas, share the disposable bank into at least one other course.
2. Run `morrow_read_item_bank_fan_out` with the `source_binding_id`, the selected `course_id`, and the `bank_id`. Leave `quiz_use_course_ids` empty on the first read.
3. Save the whole result as `03-fan-out.json`.
4. A bank shared into another course cannot reach `complete` on that first read, because Morrow reads one course through one connection and no Canvas route lists the quizzes drawing from a bank. Connect to the other course, enumerate its New Quizzes, then read the fan-out again with that course id in `quiz_use_course_ids`. Save both reads. Step 4 needs the complete one, and it expires an hour after `established_at`.

Record from the report: `status`, `summary`, `external_course_ids`, `observed.bank_entry_count`, `observed.share_row_count`, `observed.quizzes_read`, `observed.quiz_uses_found`, and every entry under `unread` with its reasons. Record from `fan_out`: `established_at`, `complete`, `consumer_count`, `consumers_sha256`, `unreachable`, and each source's `pages` and `exhausted`.

The one thing to confirm is that `list_shares` names the other course: the share you made in Canvas must appear in `external_course_ids`. If it does not, record what the share row said instead. Then note which of these is true, because each has a different consequence:

- The record is `complete`. Step 4 can run within the hour.
- The record is `incomplete` because `shared_banks` returned as many rows as Morrow asked for. Paging that route is unestablished, so Morrow records the source as unread rather than under-counting it. Step 2's `page: 2` observation is what settles it.
- The record is `incomplete` because the bank reaches a course whose quizzes nobody enumerated. That is the permanent limit: no Canvas route lists the quizzes drawing from a bank. Enumerate that course through its own connection and supply it in `quiz_use_course_ids`, or accept that the repair refuses.

## Step 4 — Write proof

One guarded alternative-text repair on the **disposable** bank question. Do not run this against a bank any course teaches from, and do not run it if step 2 could not read `canvas_item_bank_get_item`.

1. `morrow_audit_course` with `target: { kind: "item_bank_entry", item_bank_id, entry_id }`. Record `remediation.planner`, `remediation.readiness`, `target.item_id`, `target.item_sha256`, and the `image_index` and `image_src_sha256` of the missing-alt image from `observed_source_signals.image_tags_without_alt`. Record whether the audit read the question itself rather than the entry row: a row that names no readable question returns `blocked_unresolved_entry` and no plan.
2. `morrow_plan_item_bank_question_image_alt_repair` with those values, the fan-out record from step 3, and `acknowledged_course_ids` equal to exactly the `external_course_ids` that record lists. Record the operation id and the text the plan returned. Confirm it names the other courses **before** it describes the change, and that it contains no question HTML and no image URL.
3. Open the Morrow review page in the browser. It opens itself, and the plan result also carries its link at `receipts.approvalUrl` while the operation is awaiting approval. Record a screenshot and what it showed: the affected courses with their names, the alternative text, and whether any course appeared by id with a note that its name could not be read. Nobody has yet inspected this rendered page for this repair, so the screenshot is part of the proof. Do the same for the Plan and Edit settings page entry for `canvas_item_bank_question_image_alt`.
4. Approve it. The review starts the dispatch.
5. `morrow_operation_get` for that operation id. Record `status`, `effectState`, `phase`, `verification.status`, `verification.evidence`, `receipts.dispatchAttempt`, `receipts.readbackDigest`, `attention` and `limitations`. A complete result is `status: "verified"`, `effectState: "verified"`, `phase: "verified_readback"`, `verification.status: "verified"`, and `receipts.dispatchAttempt: 1`.
6. Read the question again with `canvas_item_bank_get_item` and compare it by hand against the audit: the alternative text is present on that one image, and the question text, the answers, every answer identifier, the scoring and the settings are unchanged.
7. Replay attempt. Call `morrow_operation_dispatch` with the same operation id. It must refuse, and Canvas must receive nothing. Record the refusal, then read the question once more and record that it is byte-for-byte what step 6 read.

Save all of it as `04-write.json`, with the screenshots beside it. Count the `PATCH /api/banks/{bank_id}/items/{item_id}` requests the whole sitting produced, in the Item Banks frame's DevTools Network panel filtered on `/api/banks/`: there must be exactly one. Record the `GET` requests around it too, because the guarded repair reads the item, reads the entry, and reads the item again.

If the readback answers `mismatch`, stop. Record the exact bank id, item id, bank-entry id and the failed comparison, and do not send anything again. A mismatch is a result to keep, not a problem to work around.

## Step 5 — Uncertain outcome

This one cannot be produced on demand and must never be simulated. A 5xx from the Item Banks service, a lost response, and a frame that collapses mid-operation are the three shapes that leave a write uncertain rather than failed.

If one occurs at any point in this sitting, record it as `05-uncertain.json`: what you were doing, the status or the transport error, the operation id, whether `outcomeUnknown` was true, whether the operation record said the outcome was unknown and non-retryable, and what the next fresh read of the bank showed. Then reconcile by reading the bank, never by sending the change again.

If none occurs, write in `REPORT.md` that no uncertain outcome was observed. Do not construct one, and do not write a simulated one into any record: a fabricated receipt here would be worse than the missing evidence it replaces.

## What each answer changes

| Result | What it settles |
| --- | --- |
| Step 1 confirms the storage contract | Handoff steps 1 and 2 can move from "implemented, needs a live result" to a live result, and the frame contract stops being an unlabelled dependency. |
| Step 1 refutes it | The executor's credential source, and every claim resting on it, is wrong. Record the real frame contents; the fix is source work, not a documentation change. |
| Step 2 answers all six reads | The routes, the entry and item identifier rules, and the `bank_entries` embedding behaviour of contract sections 3.2 and 3.3 become observed rather than harvested. The `page: 2` answer settles `shared_banks` paging, which section 9 lists as unestablished. |
| Step 3 names the shared course | The fan-out record's one course-association source is proved to work against a real share. |
| Step 4 completes with one dispatch and a verified readback | Handoff step 4 gains its live result, and the rendered review and settings surfaces lose their "no person has inspected" caveat in `LIMITATIONS.md`. |
| Step 5 records a real uncertain outcome | Handoff step 5's rule gains the provider behaviour that triggers it. Absence of it changes nothing and must be reported as absence. |

Update [LIMITATIONS.md](../../LIMITATIONS.md), [MORROW-1.0-HANDOFF-2026-09-06.md](MORROW-1.0-HANDOFF-2026-09-06.md), and section 9 of the contract document from the record, and from nothing else. Every sentence that changes must name the date it was observed and the course it was observed on. A step that was not done stays live-unverified, in those words.
