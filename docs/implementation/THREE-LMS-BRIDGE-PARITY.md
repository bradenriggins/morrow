# Three-platform bridge and course-work parity

Status: active implementation and contract research, 5 September 2026.

## Goal

Use the same signed-in Chrome bridge for Canvas, Moodle, and Blackboard. Bring their practical course-work features as close to parity as their verified interfaces permit. Make the website, film, marketing copy, and diagrams explain the actual product in clear language.

The user added this requirement after the first website and film review. The earlier Moodle and Blackboard token-file preview is not the desired final connection model.

## Scope and acceptance

- One extension connection flow serves the three platforms. Each request binds the platform, site, signed-in account, and exact course. Platform sign-in credentials stay inside Chrome.
- Preserve review before write, a single approved send, a fresh result check, and an explicit uncertain state. A missing response must never trigger an automatic repeat write.
- Assess parity by educator tasks: course discovery, lesson content, sections or modules, files, assignments, quizzes and questions, publication, dates, and result checks. An endpoint count does not establish feature parity.
- Use documented or directly established browser-session contracts. Refuse unavailable features with a clear explanation. Distinguish implementation, local browser proof, and live tenant proof.
- Remove the obsolete Moodle and Blackboard token-file route when its replacement works. Preserve the existing Canvas path and its verification controls.
- Check all active marketing text and diagrams for clear benefits, readable labels, and claims supported by the current implementation. Use “assistant” consistently.
- Finish with related existing tests, the broad source gate, browser checks, screenshots, final video frame inspection, and matching private package files.

## Non-goals and protected state

No public deployment, outreach, or applications. No destructive course changes. No credentials retrieval or changes to global assistant configuration. Preserve unrelated worktree files and session history. Connect and MindTap remain outside the implementation while their terms and source provenance are researched.

## Execution order

1. Establish the current bridge and provider-session contracts from source and official documentation.
2. Implement the shared connection and binding path, then the provider-specific course operations. Keep ownership separate where work can run in parallel.
3. Run the existing relevant tests and browser checks. Inspect the exact changed screens and provider results.
4. Update the feature matrix and all marketing claims from that evidence. Recheck diagrams and video after any claim change.
5. Build matching private packages and replace the stale preview handoff with current checks and explicit remaining external limits.

## Completed audience review before the bridge change

The website and silent 33.1-second film now share the promise “Move course work forward. Stay in control.” The four benefits are review before approval, checked saved results, private sign-in, and compatible assistant choice. The website passed ten layouts across 320, 390, 768, 1280, and 1440 px, plus interactive and media checks. A separate reviewer inspected the screenshots. Actual film frames exposed a clipped assistant label; the corrected export was rendered and inspected again.

These results cover the audience revision. They do not establish the requested three-platform bridge or feature parity. The goal remains active.

## Shared bridge checkpoint

Canvas and Moodle now use the same extension pairing, authenticated local connection, approval flow, and single-use effect receipt. Moodle binds the exact HTTPS site, including its installation subpath, signed-in account, and open course. The previous direct-token Moodle and Blackboard implementation and startup route were removed. Blackboard has no executable browser fallback.

The Moodle catalog now has 27 operations: thirteen reads and fourteen writes. It covers course discovery and settings, course structure, hidden Page, Assignment and Quiz creation, section text, activity settings, dates, and visibility. Operation counts describe implementation breadth. They do not prove parity or live support for every operation.

On 5 September, the real Moodle 5.2 public sandbox completed six reads through the Morrow gateway, connector process, extension, and signed-in page. A hidden disposable Page then completed a separately reviewed update. Operation `op:8fb1abba-d941-4392-ba34-aab46754aeb2` dispatched once and reached `verified`. A fresh form read and the actual Moodle Page both showed the exact requested content. Repeating that operation was refused. Root inspected the actual review, result, and Moodle screenshots.

The local receipt is `output/live-moodle/bridge-write-receipt.json`. The Page had course-module ID `9`. Moodle resets its shared public demo every hour, so this is dated test evidence, not a persistent customer course. The temporary test extension changed only its local bridge port and demo-host permission, plus diagnostic observations for this test. Those observations did not alter provider requests or approval decisions. No production course or global assistant configuration changed.

The live test exposed inactive date controls that changed with the clock, even while disabled. Their irrelevant tuple values are now excluded from the snapshot, while the native POST controls remain intact. Page revision stays in the pre-send snapshot; readback requires the exact next revision and unchanged protected fields. Independent review accepted both corrections. A focused Chrome for Testing regression covers the real DOM form behavior.

## Hidden Page creation proof

A second full bridge workflow created a hidden Page on 5 September. Operation `op:bfca261a-6838-4c4d-a562-4fbbd7cfdd9d` dispatched once and reached `verified`. The review named “My first course” and the actual selected section, showed the exact Page title and content, and stated that it was not visible to learners. The native Moodle create form received the reviewed values, preserved its other defaults, and omitted the course-content notification checkbox.

Fresh course structure showed one new Page in database section `4`, with `visible: false`. Fresh Page settings and the actual Page both showed `<p>This lesson is ready for learners.</p>`. Repeating the approved operation was refused. Root inspected the review, result, and saved Moodle Page screenshots. Independent source review found no actionable defect in the creation path. Receipt: `output/live-moodle/bridge-create-receipt.json`, captured 5 September at 17:16 UTC. The public demo later resets; this is dated test evidence.

## Native file settings and Assignment and Quiz edit proof

The live Assignment check found a second unstable snapshot input. Moodle creates a new temporary file-area ID each time it opens an Assignment form. The executor now identifies native file managers from Moodle's form markup and checks them through Moodle's signed-in draft-area list action. It replaces each temporary ID in the snapshot with a stable empty, nonempty, or unverified state. The native form still submits the current ID. A form write stops before send if a file area has files, folders, or an unverified result. This layer does not edit attached files. Source: [Moodle native file manager](https://github.com/moodle/moodle/blob/v5.2.2/public/lib/form/filemanager.php) and [draft-area list contract](https://github.com/moodle/moodle/blob/v5.2.2/public/repository/draftfiles_ajax.php).

Two consecutive live Assignment reads then produced the same digest. A reviewed instruction edit on a new hidden test Assignment completed once under operation `op:5efff7e6-a0df-4797-93ed-c87f0c997d97`. The fresh form and actual Assignment both showed the exact requested content. Existing dates and other settings stayed unchanged. Repeating the approved operation was refused. Root inspected the review, result, and saved Assignment screenshots. Receipt: `output/live-moodle/bridge-assignment-write-receipt.json`, test module `12`, 5 September at 17:36 UTC. An earlier test also saved correctly, but its final display assertion used the wrong Moodle page region; that harness error is retained in `output/live-moodle/assignment-first-view-selector-error.json`.

A separate hidden Quiz instruction edit also completed once, under operation `op:54bd4cef-0799-41b4-9067-a5e6a8c58ff8`. Fresh Quiz settings and the actual Quiz both showed the exact requested instructions. Its open and close dates remained unset. Repeating the operation was refused. Root inspected the review and saved Quiz screenshots. Receipt: `output/live-moodle/bridge-quiz-write-receipt.json`, test module `13`, 5 September at 17:39 UTC. These tests confirm selected edits on empty-file activities; they do not establish question authoring or all settings operations.

## Assignment creation and date changes

The full bridge created a hidden Assignment in the selected section under operation `op:12fceafa-bde8-4f85-85fc-78eeb123f044`. It dispatched once, reached `verified`, and refused a repeated dispatch. Fresh structure, settings, and the actual Assignment matched the requested title, instructions, section, hidden state, and four unset dates. The same disposable Assignment then accepted a separately reviewed due date under `op:fd094b8d-b652-40fc-ba4c-70cfd7a9d074`. A later connection cleared that date under `op:dadd7502-3ba2-4248-a1e3-a265623cc328`. Each write dispatched once and reached `verified`; fresh settings and the actual Assignment matched. Receipts: `output/live-moodle/assignment-create-verified-date-set-read-error.json` and `output/live-moodle/bridge-assignment-existing-dates-receipt.json`. The first receipt retains a later read failure while preparing a separate clear request; that request was never approved or sent.

These tests exposed three boundary defects. Chrome removed explicit null date fields from an object passed through `chrome.scripting.executeScript`. The worker now serializes the complete Moodle request as JSON, and the page executor parses it before the same validation. Independent MV3 probes confirmed the loss before the fix and exact null preservation afterward, without any provider write. Moodle also formats an empty new passing-grade default as zero after creation. The creation check permits only that documented empty-to-zero transition; other values and updates retain exact checks. Source: [new grading field](https://github.com/moodle/moodle/blob/v5.2.2/public/course/moodleform_mod.php) and [saved grading field](https://github.com/moodle/moodle/blob/v5.2.2/public/course/modlib.php).

The course label previously used the open page heading, which can name an activity. The executor now uses the heading only on the exact course home route. On activity pages, it uses the breadcrumb link for the bound site and course ID. Root checked the corrected Assignment date-removal review and result screens. The existing native-form test covers hidden Assignment creation, date removal, normalized grading defaults, and a distinct activity heading.

Quiz open and close dates also completed separate set and clear operations: `op:db8907c8-93f4-4efb-834f-008559aa407e` and `op:265d593d-9bd6-4755-ae16-be6d787a1bc8`. Each dispatched once, reached `verified`, and refused repetition. Root inspected the reviews, results, and actual Quiz before and after date removal. Receipt: `output/live-moodle/bridge-quiz-existing-dates-receipt.json`. This was a Quiz without questions.

A fresh hidden Quiz creation then completed under `op:cd338ef0-eade-49d5-a376-75ef690515cb`. One dispatch created exactly one Quiz in section `4`, with the approved title, instructions, hidden visibility, and unset open and close dates. Fresh settings and the actual Quiz matched. The operation reached `verified`; a repeated dispatch was refused. Root inspected all three screens. Receipt: `output/live-moodle/bridge-quiz-create-receipt.json`, captured 5 September at 18:43 UTC. The Quiz has no questions; this does not establish question authoring.

The first Quiz creation was retained as unconfirmed because Moodle collapsed two blank feedback placeholders to one saved blank row. Read-only native-form evidence confirmed that both forms contained only empty feedback and boundaries. The creation check now accepts that demonstrated empty-row change only for Quiz creation. Nonempty feedback remains protected by exact checks. Source: [native feedback repeat controls](https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/mod_form.php) and [feedback save normalization](https://github.com/moodle/moodle/blob/v5.2.2/public/mod/quiz/lib.php). The earlier unconfirmed operation was not repeated.

After these changes, `pnpm test` passed. The existing Canvas browser campaign also passed pairing, extension restart, exact course binding, governed writes, repeat refusal, and disconnect in Chrome for Testing. Root inspected the current popup and narrow approval screen.

## Activity visibility proof

A new hidden Page was created in the public test course under `op:4ff0ec60-090e-4b7d-aee0-1a42b0d01e48`. A separate approval showed that Page under `op:dcbf4585-8910-41dc-93f9-34630b0e6427`. Another approval hid it again under `op:3155b752-c5ad-4e8d-9ce1-50791cd5b2b7`. Each operation dispatched once, reached `verified`, and refused repetition. Fresh course state matched the selected visibility while the other course data stayed unchanged. Root inspected the exact review, result, course home, and Page screens. Moodle's course home showed the Page normally after show, then displayed “Hidden from students” after hide. Receipt: `output/live-moodle/bridge-page-visibility-receipt.json`, captured 5 September at 19:06 UTC. The disposable Page was module `5`; the demo resets hourly.

Source review found that Moodle derives `accessvisible`, `hascmrestrictions`, and `stealth` from activity visibility. The saved-state comparison now permits only those target fields to change with `visible`. It still requires their expected types and hidden-state values, and verifies stealth against the parent section. Other fields stay exact. Activities that control a delegated subsection stop before send because their visibility affects a wider set of items. Sources: [Moodle activity state](https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/output/local/state/cm.php), [native visibility action](https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/stateactions.php), and [delegated section effects](https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/local/cmactions.php). The existing browser regression checks show and hide, plus rejection of an unrelated activity-name change.

The review previously received only the course name from a contents read. Visibility reviews now resolve exactly one section or activity from the fresh, digest-matching course state. Missing, duplicate, or nameless targets cannot approve. Section IDs now have the same required-name check as activity IDs. Independent source review accepted these changes. The live Page reviews displayed the exact course and activity names.

Root also corrected a result-screen sentence that still used future tense after verification. The current screen says that Moodle confirmed the item is set to visible or hidden. A local read-only replay of the verified receipts passed at 390 and 1280 px. Root inspected the resulting screenshots in `output/live-moodle/visibility-result-copy/`. This copy check made no provider calls and is separate from the live visibility proof.

Section visibility remains a separate work item. Moodle also changes child activity visibility when it hides a section, then restores native prior visibility when it shows the section. The current section comparison still treats those child fields as fixed. It needs a scoped child-state check and live proof before a section-visibility support claim. Source: [native section visibility transfer](https://github.com/moodle/moodle/blob/v5.2.2/public/course/format/classes/local/sectionactions.php).

## Current website confirmation

The final audience copy passed both pages at 320, 390, 768, 1280, and 1440 px on 5 September at 18:56 UTC. Menu navigation, lesson and quiz examples, keyboard tabs, exact setup clipboard content, and actual film playback passed. A shorter build-limits paragraph passed again at 320, 390, and 1280 px. An independent reviewer accepted the copy and layouts, then found one Canvas-only setup instruction. That instruction now names Canvas or Moodle. Its final setup card passed targeted checks at 320, 390, and 1280 px, and root inspected the mobile and desktop screenshots. Reports are in `output/playwright/final-polish-website/{audience-final,final,setup-final}/`.

The Moodle provider cell now uses plain, compact wording. Detailed evidence names hidden creation and Quizzes without questions. Attached-file limits are explicitly scoped to Moodle. Active marketing contains no “AI app.” Root reconfirmed that the film and poster in the website are byte-identical to the inspected exports. The film did not change during this copy pass.

## Remaining practical parity work

| Educator task | Moodle current layer | Remaining work |
|---|---|---|
| Find courses and content | Six selected live reads confirmed. | Broader tenant and role checks. |
| Create or edit a lesson | Standard hidden Page creation and one Page update confirmed through full review and readback. | Broader content and tenant checks. |
| Build course structure | Read structure; place a new hidden Page, Assignment, or Quiz in a selected section; edit section text; show or hide sections and activities. | Reorder structure; live-check other supported writes. |
| Assignment and quiz settings | Hidden Assignment and questionless Quiz creation, instruction edits, Assignment due-date set and clear, and Quiz open/close date set and clear confirmed live. | One Page show/hide workflow is confirmed. Broader activity types, settings, and tenant checks remain. Form writes require empty file areas. |
| Quiz questions | No browser operations yet. | Add course-local question inspection. Resolve complete effect scope before shared question-bank writes. |
| Files and learner results | No Moodle operations yet. Native Resource creation and upload form contract checked read-only in the public demo. | Verified file admission, upload and saved-byte checks; scoped learner-data controls. |
| Blackboard | Browser transport remains unverified and unavailable. | An authorized signed-in test course is required to establish the actual session contract. |

Moodle question edits create new question-bank versions. Other references that use the latest version can move to that version. The normal Usage screen omits random question filters and does not establish complete use across components or inaccessible quizzes. A zero Usage count cannot establish a one-quiz effect. The first question layer should provide inspection while this write boundary is resolved. Source: [Moodle question Usage query](https://github.com/moodle/moodle/blob/v5.2.2/public/question/bank/usage/classes/helper.php), [question reference semantics](https://github.com/moodle/moodle/blob/v5.2.2/public/question/classes/question_reference_manager.php), and [random question selection](https://github.com/moodle/moodle/blob/v5.2.2/public/question/classes/local/bank/random_question_loader.php).

The website and film must reflect these limits. Public deployment, final private packaging, and project completion remain pending the full acceptance criteria.
