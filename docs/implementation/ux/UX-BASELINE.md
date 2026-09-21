# UX baseline (WI-0.1)

Measured on commit `1ff008203`, branch `ux/build-20260921`, before any product file changed. No real course and no person: D11 lets an agent do this with the harness and the product text alone (`docs/implementation/ux/MORROW-UX-BUILD-SPEC.md`, Fact D11). Every row below carries its own source citation, marked one of two ways per WI-0.1's instructions:

- **counted from the text.** I read the exact strings and control lists in the source file named, and counted each named control as one action. No script ran.
- **measured in the harness.** A script produced the number directly.

Two numbers in this file are neither: they are the reference document's own earlier estimate, carried forward because I did not independently re-derive them this pass. Each is flagged in place, not presented as a fresh measurement.

## Interaction budget, one row for each moment in `docs/implementation/ux/reference/audit-page.html#budget`

| Moment | Cost today | Target (unchanged from the reference) | How counted |
|---|---|---|---|
| **Setup, to the first read of a course** | About 19 actions with a store listing. About 21 with Developer mode. | 9 or fewer. "Add to Chrome" opens the listing. One sign-in tab is sufficient. | Counted from the text. Walked the panel sequence in `installer/shared/setup-view.mjs`: choose an assistant and set it up (`actionPanel`, :274-281, 2 actions); the Bridge panel, either "Install Morrow Bridge" (:325-330, 3 named controls in the store `<ol>` + 1 "Check Bridge" = 8 actions) or "Add Morrow Bridge" (:318-323, Developer mode `<ol>` + "Check Bridge" = 10 actions); "Open your course in Chrome" (:340-345, 8 named controls); "Check your course connection" (:355-360, 1 action). Store total 2+8+8+1=19. Developer total 2+10+8+1=21. |
| **One approved change** | 2 app switches (assistant to browser for the review, browser back to the assistant), find the link in the assistant's reply, 1 click to approve, 1 typed message to resume the assistant. | 1 click on a link named after the change, 1 click to approve. No typed message. The Bridge popup also lists the review. | Counted from the text. Spec facts F16 (`packages/gateway-core/src/result.ts:47`, the exact resume sentence the assistant receives) and F17 (`packages/mcp-server/src/operation-tools.ts:44`, `approval-server.ts:1229`: no tool waits for the review, so the person must return to the assistant and say to continue). |
| **The same kind of change again, same course, same day** | The full cost again. | 0. The assistant reports it. | Counted from the text. No "do not ask again" memory exists in `src/edit-policy.js` today; D2b/D3 in the spec's decisions table name this as new work (WI-4.x), not yet built. |
| **Ten changes of one kind** | 1 review if the assistant's tool call already batches the changes into one operation; 10 if it issues ten separate operations. | 1 review. Morrow tells the assistant to batch. | Counted from the text. `approval-server.ts` reviews one operation per `operationGet`/`approveOperation` call; nothing in `runtime.ts` or `morrow-runtime.ts` merges separate same-kind operations server-side. WI-2.3 (batching guidance) is unbuilt. |
| **Come back the next day, tabs closed** | Open the platform by hand, open a course, reload the Bridge page. | 0 clicks. The Bridge opens the site when work arrives. | Counted from the text, partial. `src/service-worker.js` has no path that opens a tab when an operation needs a closed course site (D1a's auto-open is new work, WI-1.2). The reference audit page's specific figure "0 of 3 courses were ready on this computer" came from an earlier real-course walkthrough; I did not repeat that measurement this pass because opening a real Canvas, Moodle or Blackboard site is forbidden for this agent, so I report the structural cost only, not a fabricated course count. **Person check, not blocking**, for the course-count figure specifically. |
| **"Can Morrow change anything now?"** | Open Settings and read each course card. | A glance at the Bridge icon. | Counted from the text. No `chrome.action.setBadgeText` (or similar) call exists anywhere in `connector/extension/src/service-worker.js`; the toolbar badge (WI-1.3) is unbuilt. |
| **Stop all access** | Select courses (per-row checkboxes, or "Select this page" for up to 6), then click "Return selected courses to Plan". | 1 click. | Counted from the text. `connector/extension/settings/settings.html:142` (the button, disabled until a selection exists) and `settings.js:1142` (`returnToPlan`), `:1464` (its click handler). The click itself already matches the target; selecting the courses first still costs one action per course today, since there is no single "every course, every page" selector. |
| **"What did Morrow change today?"** | Ask the assistant. No view exists. | 1 click to a list with links to each item. | Counted from the text. No history or "recent changes" list appears in `popup/popup.js` or `settings/settings.js`. `approval-server.ts`'s `operationList` returns a page of operations but is not surfaced as a browsable list in the Bridge UI. WI-6.4 ("Recent changes") is Phase 6, unbuilt. |
| **Find one course among 40** | 7 pages of 6. Search matches the course's provider, origin, site URL, internal course ID, name or principal ID, not a human course code. | Type the course code. | Measured in the harness for the page size: `PAGE_SIZE = 6` at `connector/extension/settings/settings.js:62`, so 40 courses paginate into `⌈40/6⌉ = 7` pages. Counted from the text for the search fields: `matchingItems()` at `settings.js:358-365` filters on `provider, origin, siteUrl, courseId, courseName, principalId`; no `courseCode`/`course_code` field is read into a binding anywhere in `settings.js` or `service-worker.js`, so a Canvas course code (for example "BIO101") is not itself searchable, only the internal `courseId` and the display `courseName` are. |
| **Allow a whole area of work** | Up to 141 checkboxes, one at a time. | 1 switch for routine work, or 1 checkbox for an area. | Not independently re-verified this pass; carried from the reference audit page's own earlier count. I confirmed the shape that makes it plausible: `settings.js:557` renders one `<input type="checkbox">` per category with no group-level toggle beside it, and spec fact F10 gives the catalog scale behind that count (347 grantable Canvas options, 58 of which even a full grant changes nothing in, at `src/edit-policy.js:26`, `:496`, `:526`). I did not re-walk the curated category tree to recompute 141 directly. |

## Census table (WI-T.1, `node scripts/ux/census.mjs`, this commit)

Reads computed styles only; changes nothing. WI-F.2's targets: 7 sizes, 3 weights, 4 line heights, 4 radii, small text and small targets both 0, no long lines, gaps and paddings on the space-token set. None of the five surfaces meet the full target set yet, which is expected before Foundation (RF) ships.

| Surface | Sizes | Weights | LineHt | Radii | Gaps | Paddings | Small text | Small targets | Long lines |
|---|---|---|---|---|---|---|---|---|---|
| Popup | 4 | 4 | 4 | 4 | 3 | 7 | 21 of 27 | 2 | 0 |
| Settings page | 8 | 5 | 9 | 6 | 8 | 11 | 6 of 36 | 3 | 12 |
| Setup guide | 5 | 4 | 6 | 4 | 3 | 6 | 0 of 21 | 1 | 10 |
| Edit list | 8 | 4 | 7 | 2 | 3 | 9 | 5 of 14 | 1 | 4 |
| Desktop app, set up | 9 | 8 | 10 | 7 | 12 | 15 | 26 of 50 | 0 | 10 |

Command: `node scripts/ux/census.mjs`, run from the worktree root on commit `1ff008203`. The table above is that run's output, transcribed unedited.

## Batch B

Batch B is WI-T.1 (the census tool) and WI-0.1 (this document). No product file changed in this batch, so no budget row has an old value to compare against; every row above is this batch's own first measurement, not a change from a prior one.

Re-ran `node scripts/ux/census.mjs` after the batch's files were in place, from the worktree root, no product file touched. Output reproduced the census table above exactly, cell for cell:

| Surface | Sizes | Weights | LineHt | Radii | Gaps | Paddings | Small text | Small targets | Long lines |
|---|---|---|---|---|---|---|---|---|---|
| Popup | 4 | 4 | 4 | 4 | 3 | 7 | 21 of 27 | 2 | 0 |
| Settings page | 8 | 5 | 9 | 6 | 8 | 11 | 6 of 36 | 3 | 12 |
| Setup guide | 5 | 4 | 6 | 4 | 3 | 6 | 0 of 21 | 1 | 10 |
| Edit list | 8 | 4 | 7 | 2 | 3 | 9 | 5 of 14 | 1 | 4 |
| Desktop app, set up | 9 | 8 | 10 | 7 | 12 | 15 | 26 of 50 | 0 | 10 |

Measured in the harness.

Budget rows this batch changed, one line per row in the "Interaction budget" table above, each carrying the same source mark the row itself carries:

- Setup, to the first read of a course: measured in the harness for the census table's font/gap/target counts, cited above. Counted from the text for the 19/21-action walk through `installer/shared/setup-view.mjs`, unchanged by this batch.
- One approved change: counted from the text. No harness figure applies; the row cites spec facts F16/F17, unchanged by this batch.
- The same kind of change again, same course, same day: counted from the text. No `src/edit-policy.js` memory exists yet; this batch touched no product file, so the fact stands unchanged.
- Ten changes of one kind: counted from the text. `approval-server.ts` batching behavior unchanged by this batch.
- Come back the next day, tabs closed: counted from the text, partial (see the row's person-check note). `src/service-worker.js` unchanged by this batch.
- "Can Morrow change anything now?": counted from the text. No badge call exists in `connector/extension/src/service-worker.js`; unchanged by this batch.
- Stop all access: counted from the text. `settings.html`/`settings.js` selection flow unchanged by this batch.
- "What did Morrow change today?": counted from the text. No history view in `popup/popup.js` or `settings/settings.js`; unchanged by this batch.
- Find one course among 40: measured in the harness for `PAGE_SIZE = 6`; counted from the text for the searchable-field list. Neither source changed, since this batch touched no product file.
- Allow a whole area of work: carried forward, not independently re-verified this pass, same as the row states. Unchanged by this batch.

Every row's underlying source file is one this batch did not touch (`scripts/ux/**` and `docs/implementation/ux/UX-BASELINE.md` are the only files batch B owns), so every row's value from WI-0.1's original pass stands as this batch's value. Verify command run: `node scripts/ux/census.mjs && node --test scripts/test/no-em-dash.test.mjs`. Last lines of `node --test scripts/test/no-em-dash.test.mjs` and the census run are in the work item report for this batch.
