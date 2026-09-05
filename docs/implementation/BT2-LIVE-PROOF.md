# BT2 live proof and preview handoff

Recorded September 4–5, 2026. This is a private test record for Braden's Test 2, Canvas course `89585`. Public launch assets use fictional, unidentifiable examples.

## Result at this checkpoint

The live test created a lesson, a New Quiz, a module, and three quiz questions. Independent model requests found two planted errors. An approved lesson correction reached verified Canvas readback. A second proposal based on the old lesson failed before send and left the saved page unchanged.

The answer-key correction and both module links are verified. The lesson, quiz, and module are published. Canvas Student View opened the lesson, followed its Next module link, displayed all three quiz questions, and returned 3/3 with feedback. The result survived a reload. Canvas Grades and an independent submission API read also confirmed the score. This is one selected sandbox workflow, not a full-catalog or learning-efficacy claim.

The final unpublished page-creation check passed after a normal Chrome connector reload. Operation `op:dfd57c19-3063-44e1-ba18-9616fe2ee57e` dispatched once and reached `verified`. An independent canonical-URL read confirmed page `3445390`, its exact body and title, and all requested saved settings. The actual review screen showed “Changes confirmed.” Earlier uncertain creations were not replayed.

The installed Codex interactive client also completed a governed page update. Its native **Allow** prompt let Morrow stage one paragraph append. The separate Morrow review showed the current and proposed content. After approval, operation `op:134d6aef-0b0f-4273-9a5f-42125ccbf971` dispatched once and reached `verified`. Native and independent later reads confirmed the exact body and unchanged protected page fields. The review screen showed “Changes confirmed.”

## Live resources

| Resource | Exact saved target | Current proof |
|---|---|---|
| Lesson | [Morrow Lab · Cell structures](https://example-kit.instructure.com/courses/89585/pages/morrow-lab-star-cell-structures), page `3445381` | Corrected, published, independently read, and opened in Student View. |
| New Quiz | [Morrow Lab · Cell structures check](https://example-kit.instructure.com/courses/89585/assignments/4016123), assignment `4016123` | Corrected key, preserved other fields, published, completed by Test Student, and graded 3/3. |
| Module | `951814`, Morrow Lab · From evidence to understanding | Published with lesson item `9981678` and quiz item `9981679`; learner navigation verified. |
| Native update target | page `3445388`, `morrow-lab-star-verification-record` | Earlier create readback was unconfirmed; later reads succeeded. The separately reviewed native Codex update verified one exact paragraph append with unchanged protected fields. |
| Final creation proof | [Morrow Lab · Verified source record](https://example-kit.instructure.com/courses/89585/pages/morrow-lab-star-verified-source-record), page `3445390` | One dispatch, automatic verification, exact independent readback, and confirmed review screen. Unpublished; teachers can edit. |

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
| Final page creation | `099`–`102`, `final-page-create-proof.json` | One dispatch; `verified`; exact page ID, canonical URL, body, title, roles, front-page, and publication state confirmed. |
| Noninteractive Codex write attempts | `codex-native-governed-update-retry.receipt.json`, `097`, `098` | Native MCP approval cancelled before the call reached Morrow. The full page object remained unchanged and no new native operation appeared. |
| Native Codex interactive update | `codex-native-governed-update-interactive.native-proof.receipt.json` | Codex CLI `0.144.4`, using GPT-5.5, staged the exact update after native tool approval. Separate Morrow approval led to one dispatch and `verified`. Native readback matched the approved body and preserved page settings. |
| Independent native-update readback | `105`, `106`, `native-update-independent-proof.json` | After the native client exited, a separate runtime read the verified operation and exact saved page. The requested paragraph was appended once; ID, URL, title, publication, editing roles, front-page, and hidden-from-students fields were unchanged. |
| Refresh after layout changes | `107`–`113`, `final-polish-live-refresh.json` | The installed connector reconnected. Both selected page operations remained `verified` with one dispatch. Fresh page reads matched the previous body, identity, settings, and update time. The real confirmed-result page was inspected at 1280 × 720 after the layout and wording changes. No new Canvas write was requested. |
| Native Codex connected read | `codex-native-bt2-quiz-read.jsonl` | Codex CLI `0.144.4`, using GPT-5.5, called actual health, Canvas binding, and New Quiz read tools. The bridge was connected. The exact sandbox quiz returned `succeeded`, complete read, and HTTP 200. Only those three read tools were exposed. |

The source review used a manual MCP host adapter to connect actual Codex model workers to Morrow sampling requests. It does not prove automatic sampling support in every native assistant. Gemini CLI could not run because it has no configured authentication. The installed Codex CLI rejected Astra as requiring a newer client; the successful native connected read used GPT-5.5.

The interactive update preserved the project Codex configuration checksum. The global Codex configuration checksum changed during that run; its exact cause was not established. The native tool and independent LMS receipts prove the selected update, but this run does not support a claim that global client configuration stayed unchanged. No global configuration was restored or edited to conceal that difference.

## Defects found and corrected in source

- The native extension popup collapsed to a narrow column. It now has an explicit 360 px width, compact status rows, and readable controls. The actual Chrome popup was visually checked after reopening it.
- Canvas writes looked for a CSRF meta tag that this Canvas page did not provide. The connector now uses Canvas's `_csrf_token` cookie within the signed-in page. Missing CSRF state still blocks the write.
- Page creation lacked an exact page readback route. The comparator now uses the returned canonical page URL and requires the exact `page_id` and requested saved field values. A later live test exposed a separate assertion on `wiki_page_notify_of_update`, which Canvas accepts as a request option but omits from the Page response. The comparator excludes that option from saved-field assertions while retaining it in the reviewed request. It does not claim notification delivery. The final distinct creation verified automatically. Earlier uncertain records remain intact; no create was replayed. [Canvas Pages API](https://canvas.instructure.com/doc/api/pages.html)
- Source review rejected anonymized editor metadata that was outside its evidence projection. The review now accepts that metadata without sending it as learning evidence.
- The generated module-item contract incorrectly required a content ID for Page links. Page links now require the page slug; the other documented conditional requirements remain enforced.
- A quiz answer-key-only review showed a raw choice ID. The review now uses separately captured question context to show the question, current key, and proposed answer text. That display data is not added to the write payload.
- A known before-send failure had a vague result screen. It now says that no change was sent and asks for a fresh read and review. Uncertain after-send results retain their separate wording.
- The browser test used the installed connector's port. It now assigns an isolated test port to its temporary Chrome for Testing extension.

## Local verification and package

`pnpm check` passed: 159 workspace tests and 21 script tests. The connector browser campaign passed against temporary Chrome for Testing, including pairing, reconnect, account binding, a New Quiz item write, replay refusal, and missing-CSRF refusal. The native popup and the live lesson-result screen were also inspected visually.

The final design pass uses the original light/dark wordmark, Google Sans Flex, white and cool-neutral surfaces, graphite text, and violet actions. The popup was inspected in the installed Chrome window. Pairing, review, confirmed, expired, and narrow screens were inspected from the browser campaign. Muted light-theme labels have at least 5.51:1 contrast on the used surfaces. Known connector-version mismatches now give a reload/update instruction; unrelated failures retain bounded generic messages.

Three product layout passes produced 90 final screenshots across 45 measured layouts in light and dark themes, at desktop and narrow widths. The final measurements found no horizontal overflow. The pass corrected narrow title and tab wraps, question/points alignment, excess result-footer space, and the default margins inside Blackboard content wrappers. All 11 related approval, context, operation, and provider integration tests passed. The existing connector browser campaign also passed. Both Moodle and Blackboard reached “Changes confirmed” through isolated local fixtures. These fixtures are not live tenant evidence. Reports and screenshots are in `output/playwright/final-polish-product/`.

`pnpm package:connector` and `pnpm package:connector:check` passed. The local archive is `artifacts/connector/morrow-canvas-connector-v1.0.1.zip`.

SHA-256: `c003b82e052ac12c71782b8da84401818c4023956aed421432d24a6d8e3ff1e7`.

Catalog digest: `a9b5529753ae663db279dce802586255fe45412482cff72eeade8bd8b574927a`.

## Historical Moodle and Blackboard API validation (retired)

The direct-token paths described in this historical section were removed during the later shared-bridge work. They are not current setup or capability instructions. Current browser implementation and live Moodle evidence are in [THREE-LMS-BRIDGE-PARITY.md](THREE-LMS-BRIDGE-PARITY.md).

Braden has no Moodle or Blackboard test tenant. Their implemented adapters were checked against official Moodle 5.2.2 source and the official Blackboard Learn API specification. This is documented API and local adapter evidence, not live tenant proof.

Both providers have six tools: five reads and one bounded write. Blackboard now includes direct-child discovery so an Ultra document body can be found under its page wrapper. The new tests confirm exact parent/course binding and refuse a child from another parent. The existing large-document gateway test now uses permitted BbML markup and preserves exact readback checks.

The focused provider, connection, and gateway suite passed all 10 tests. An independent public-stdio probe confirmed that forged `outer_grant` fields are rejected, a normal write remains `awaiting_approval`, and unapproved dispatch is refused. The trusted internal adapter is not a separate supported AI-client entrypoint. The [provider checkpoint](MULTI-LMS-AND-LESSON-REVIEW.md) records API sources and setup limits.

## Delivery verification

The shared Canvas/Moodle source has not yet been packaged as a final private candidate. Earlier archive and installation evidence does not verify this changed source. A final archive must identify its exact committed revision, checksum, deterministic rebuild, and scan result. An install in a fresh directory on this Mac does not establish independent-machine compatibility. Public release requires separate source-rights evidence and Braden's preview approval.

After renewed user authorization, Chrome’s normal extension Details page confirmed the active worktree path and returned “Reloaded.” No alternate management route or extension lifecycle script was used.

## Website and promotion

The earlier layout preview used `http://127.0.0.1:4173`. The current audience-review preview is `http://127.0.0.1:4175`. Its lesson and quiz interactions are explicitly illustrative. Three layout passes covered both pages at 320, 390, 768, 1280, and 1440 px. All ten final page layouts matched the viewport width without content outside it or console errors. The main heading uses two complete phrases. The pass also corrected the narrow review heading, tablet pillar columns, excess setup-card height, and a decorative orbit that extended the laptop page by 22 px. Menus, both demonstrations, keyboard tabs, and exact setup clipboard content passed. The report is `output/playwright/final-polish-website/REPORT.md`.

`launch/` contains positioning, home page copy, a private-evaluation launch sequence, three post drafts, video scripts, a finished expert article, a hiring case study, and a researched employer shortlist with outreach drafts. The founder story explains the months of work through concrete operation controls and selected Canvas evidence. `website/build.html` presents the system and its verified evidence for hiring readers. `launch/video/` contains the editable HyperFrames composition and local MP4 preview. All main demonstration scenes were rebuilt after review of the sparse first version. The earlier 25.2-second film was superseded during the 5 September audience review. The current source is a 33.1-second, 1920×1080, 30 fps silent, illustrative film. Current export hashes and acceptance results belong in the private preview handoff after its final render check.

Cloudflare access was checked with read-only requests. The existing `meetmorrow` Pages project and `meetmorrow.app` zone were found. The apex has no A, AAAA, or CNAME website record in the inspected zone. No Cloudflare, DNS, public website, or promotion changes were made. Public deployment remains pending Braden's preview approval.
