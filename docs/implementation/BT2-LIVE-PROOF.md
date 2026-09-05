# BT2 live proof and preview handoff

Recorded September 4–5, 2026. This is a private test record for Braden's Test 2, Canvas course `89585`. Public launch assets use fictional, unidentifiable examples.

## Result at this checkpoint

The live test created a lesson, a New Quiz, a module, and three quiz questions. Independent model requests found two planted errors. An approved lesson correction reached verified Canvas readback. A second proposal based on the old lesson failed before send and left the saved page unchanged.

The answer-key correction and both module links are verified. The lesson, quiz, and module are published. Canvas Student View opened the lesson, followed its Next module link, displayed all three quiz questions, and returned 3/3 with feedback. The result survived a reload. Canvas Grades and an independent submission API read also confirmed the score. This is one selected sandbox workflow, not a full-catalog or learning-efficacy claim.

A separate unpublished page-creation check reached `awaiting_verification` because its immediate readback returned HTTP 404. Later reads by ID and canonical URL found the exact saved page. The source now uses the returned canonical URL while checking the exact page ID. Its next live creation check awaits the normal connector reload; the earlier create is not replayed.

## Live resources

| Resource | Exact saved target | Current proof |
|---|---|---|
| Lesson | [Morrow Lab · Cell structures](https://example-kit.instructure.com/courses/89585/pages/morrow-lab-star-cell-structures), page `3445381` | Corrected, published, independently read, and opened in Student View. |
| New Quiz | [Morrow Lab · Cell structures check](https://example-kit.instructure.com/courses/89585/assignments/4016123), assignment `4016123` | Corrected key, preserved other fields, published, completed by Test Student, and graded 3/3. |
| Module | `951814`, Morrow Lab · From evidence to understanding | Published with lesson item `9981678` and quiz item `9981679`; learner navigation verified. |
| Unpublished creation record | page `3445388`, `morrow-lab-star-verification-record` | Exists with exact requested body, title, and settings. Immediate create readback was unconfirmed; later reads succeeded. |

The short reference summary came from [OpenStax Biology 2e, 4.3 Eukaryotic Cells](https://openstax.org/books/biology-2e/pages/4-3-eukaryotic-cells). It states that ribosomes assemble proteins and mitochondria produce ATP through cellular respiration.

## Evidence

Raw local records are in the ignored `output/live-bt2/` directory. They retain the request, result, and UTC timestamp. They are not public website assets.

| Check | Record | Observed result |
|---|---|---|
| Quiz and module creation | `031-morrow_batch_get.json` | Batch `bat:df3a4d0c-befc-496e-b35d-2f0906354b1a` completed; 2 succeeded, 0 failed, 0 unknown. |
| Three question writes | `035-morrow_batch_get.json`, `036-canvas_list_quiz_items.json` | Batch `bat:69fd1a68-ff6e-4b3e-8e6c-b35485d905f2` completed; 3 succeeded, 0 failed, 0 unknown. |
| Source review | `039-morrow_review_lesson.json` | Two independent Terra requests plus an Astra checker retained the planted lesson error and the wrong saved quiz key. The report requires educator review. |
| Reviewed lesson correction | `040-morrow_plan_page_correction.json`, `042-morrow_operation_get.json` | Operation `op:2061a635-709f-4ccd-b3b1-cfb6110bdfab` dispatched once and reached `verified`. |
| Independent page comparison | `028-canvas_show_page_courses.json`, `043-canvas_show_page_courses.json` | The complete body equals the previous body with exactly one phrase replaced. Title, URL, publication state, front-page state, and editing roles are unchanged. |
| Stale proposal | `041-morrow_plan_page_correction.json`, `044-morrow_operation_get.json` | Operation `op:ef3a8ebe-47c9-4b50-a2e5-59962a135443` failed with `dispatch_failed_before_send`. |
| No later page effect | `043-canvas_show_page_courses.json`, `045-canvas_show_page_courses.json` | The body and `updated_at` are identical after the stale proposal. |
| Readable answer-key correction | `055-canvas_update_quiz_item.json`, `057-morrow_operation_get.json` | `op:8589be72-4edd-4ea2-b513-18a0a23c43df` showed Mitochondria → Ribosomes, dispatched once, and reached `verified`. |
| Exact quiz comparison | `054-canvas_list_quiz_items.json`, `056-canvas_list_quiz_items.json`, `quiz-key-exact-readback.json` | Only question 1's answer key and update timestamp changed. All other fields across all three questions stayed equal. |
| Module links | `060-morrow_operation_get.json`, `063-morrow_operation_get.json`, `078-canvas_list_module_items.json` | Both writes verified with one dispatch each; exact lesson and quiz targets read back in order. |
| Publication | `070`–`075` | Lesson, quiz, and module publication verified. Later reads returned `published: true`. The lesson palette changed without changing its text; the complete saved body matched the request. |
| Student journey and score | `learner-path-proof.json`, `079-canvas_get_single_submission_courses.json` | Actual Student View launch, all three questions, 3/3 and feedback; result persisted after reload. Canvas Grades showed 3/3. Independent API read returned attempt 1, score 3, `graded`, and `grade_matches_current_submission: true`. |
| Separate page-create check | `076`, `077`, `080`–`082` | One dispatch; immediate readback HTTP 404. Later list, ID, and canonical-URL reads found page `3445388` with the exact requested body and settings. No replay. |
| Native Codex connected read | `codex-native-bt2-quiz-read.jsonl` | Codex CLI `0.144.4`, using GPT-5.5, called actual health, Canvas binding, and New Quiz read tools. The bridge was connected. The exact sandbox quiz returned `succeeded`, complete read, and HTTP 200. Only those three read tools were exposed. |

The source review used a manual MCP host adapter to connect actual Codex model workers to Morrow sampling requests. It does not prove automatic sampling support in every native AI app. Gemini CLI could not run because it has no configured authentication. The installed Codex CLI rejected Astra as requiring a newer client; the successful native connected read used GPT-5.5.

## Defects found and corrected in source

- The native extension popup collapsed to a narrow column. It now has an explicit 360 px width, compact status rows, and readable controls. The actual Chrome popup was visually checked after reopening it.
- Canvas writes looked for a CSRF meta tag that this Canvas page did not provide. The connector now uses Canvas's `_csrf_token` cookie within the signed-in page. Missing CSRF state still blocks the write.
- Page creation lacked an exact page readback route. The comparator now uses the returned canonical page URL and requires the exact `page_id` and requested field values. Two historical creation records remain unconfirmed in the journal; independent saved-page reads prove that they exist. The latest failure was an immediate HTTP 404, not a proved body mismatch or catalog mismatch. No uncertain create was replayed.
- Source review rejected anonymized editor metadata that was outside its evidence projection. The review now accepts that metadata without sending it as learning evidence.
- The generated module-item contract incorrectly required a content ID for Page links. Page links now require the page slug; the other documented conditional requirements remain enforced.
- A quiz answer-key-only review showed a raw choice ID. The review now uses separately captured question context to show the question, current key, and proposed answer text. That display data is not added to the write payload.
- A known before-send failure had a vague result screen. It now says that no change was sent and asks for a fresh read and review. Uncertain after-send results retain their separate wording.
- The browser test used the installed connector's port. It now assigns an isolated test port to its temporary Chrome for Testing extension.

## Local verification and package

`pnpm check` passed: 159 workspace tests and 21 script tests. The connector browser campaign passed against temporary Chrome for Testing, including pairing, reconnect, account binding, a New Quiz item write, replay refusal, and missing-CSRF refusal. The native popup and the live lesson-result screen were also inspected visually.

The final design pass uses the original light/dark wordmark, Google Sans Flex, white and cool-neutral surfaces, graphite text, and violet actions. The popup was inspected in the installed Chrome window. Pairing, review, confirmed, expired, and narrow screens were inspected from the browser campaign. Muted light-theme labels have at least 5.51:1 contrast on the used surfaces. Known connector-version mismatches now give a reload/update instruction; unrelated failures retain bounded generic messages.

`pnpm package:connector` and `pnpm package:connector:check` passed. The local archive is `artifacts/connector/morrow-canvas-connector-v1.0.1.zip`.

SHA-256: `ecd3f999c0c2f67ccb4cd59ab5500230b6ea44239d78ec04637d9223c36fdbb3`.

Catalog digest: `a9b5529753ae663db279dce802586255fe45412482cff72eeade8bd8b574927a`.

## Moodle and Blackboard API validation

Braden has no Moodle or Blackboard test tenant. Their implemented adapters were checked against official Moodle 5.2.2 source and the official Blackboard Learn API specification. This is documented API and local adapter evidence, not live tenant proof.

Both providers have six tools: five reads and one bounded write. Blackboard now includes direct-child discovery so an Ultra document body can be found under its page wrapper. The new tests confirm exact parent/course binding and refuse a child from another parent. The existing large-document gateway test now uses permitted BbML markup and preserves exact readback checks.

The focused provider, connection, and gateway suite passed all 10 tests. An independent public-stdio probe confirmed that forged `outer_grant` fields are rejected, a normal write remains `awaiting_approval`, and unapproved dispatch is refused. The trusted internal adapter is not a separate supported AI-client entrypoint. The [provider checkpoint](MULTI-LMS-AND-LESSON-REVIEW.md) records API sources and setup limits.

## Remaining verification

1. Load the final canonical-URL comparator through a normal user-managed connector reload. Verify one new, distinct unpublished page creation without replaying either prior create.
2. Freeze the final source, create the private archive, and install/build it in a fresh directory.

Computer Use approval review previously blocked Chrome extension management. No alternate management route or script was used. The connector later connected with its expected catalog, which enabled the completed quiz and learner checks above.

## Website and promotion

`website/` is served locally at `http://127.0.0.1:4173`. Its lesson and quiz interactions are explicitly illustrative. Desktop and 390 px mobile layouts were inspected; page width equals viewport width at 390 px, the mobile menu works, and the embedded H.264 video loads without an error.

`launch/` contains positioning, home page copy, a private-evaluation launch sequence, three post drafts, video scripts, a finished expert article, a hiring case study, and a researched employer shortlist with outreach drafts. The founder story explains the months of work through concrete operation controls and selected Canvas evidence. `website/build.html` presents the system and its verified evidence for hiring readers. `launch/video/` contains the editable HyperFrames composition and local MP4 preview. All main demonstration scenes were rebuilt after review of the sparse first version. The final 25.2-second, 1920×1080, 30 fps film is silent and illustrative.

Cloudflare access was checked with read-only requests. The existing `meetmorrow` Pages project and `meetmorrow.app` zone were found. The apex has no A, AAAA, or CNAME website record in the inspected zone. No Cloudflare, DNS, public website, or promotion changes were made. Public deployment remains pending Braden's preview approval.
