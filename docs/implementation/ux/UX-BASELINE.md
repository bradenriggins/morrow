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

## Batch S1

Batch S1 is the CSS-foundation cards (WI-F.1, WI-F.3, WI-F.4, WI-F.2, WI-F.5, WI-F.6, WI-F.7, WI-F.11), the review-page RF cards (WI-F.8, WI-F.9a), the PAGES RF card (WI-F.10), the "Open Canvas/Moodle" and auto-open cards (WI-1.1a, WI-1.2, WI-1.1b), the toolbar badge (WI-1.3), the banner and remaining PAGES copy cards (WI-1.4, WI-1.5a, WI-1.6a), the desktop setup-screen card (WI-1.5b), and the runtime edit-access card (WI-1.6b). This measurement pass is read-only: no product file was edited for this batch's baseline entry, only `docs/implementation/ux/UX-BASELINE.md`. Measured against the worktree's current state (uncommitted, on top of the batch B checkpoint commit `09dd29b24`), before the batch's own checkpoint commit.

Ran `node scripts/ux/census.mjs` from the worktree root. Output, transcribed unedited:

| Surface | Sizes | Weights | LineHt | Radii | Gaps | Paddings | Small text | Small targets | Long lines |
|---|---|---|---|---|---|---|---|---|---|
| Popup | 2 | 3 | 3 | 3 | 3 | 7 | 0 of 28 | 1 | 0 |
| Settings page | 6 | 3 | 4 | 3 | 6 | 8 | 0 of 36 | 2 | 0 |
| Setup guide | 5 | 3 | 3 | 3 | 2 | 6 | 0 of 21 | 1 | 0 |
| Edit list | 6 | 3 | 4 | 2 | 3 | 9 | 0 of 14 | 0 | 1 |
| Desktop app, set up | 5 | 3 | 4 | 4 | 6 | 12 | 0 of 50 | 0 | 4 |

Measured in the harness. Every surface's small-text count is now 0 (font sizes are up off the 13px floor across the board), and four of five surfaces already sit at or under WI-F.2's weight and line-height targets (3 weights, 4 or fewer line heights); Settings page and Desktop app still carry more distinct sizes (6, 5) than the 7-size target allows headroom for once combined with their gap/padding counts, and neither is at `--check` green yet. This is expected mid-batch: WI-F.2 through WI-F.7 land the token moves in sequence, and WI-F.10/1.1b/1.4/1.5a/1.6a add markup after the tokens are in.

Budget rows this batch changed, one line per row in the "Interaction budget" table above, each carrying the same source mark the row itself carries. Old value is the number from WI-0.1's first pass (baseline section above); new value is this batch's:

- **Setup, to the first read of a course.** Counted from the text: unchanged. `installer/shared/setup-view.mjs`, the file the 19/21-action walk-through cites, is not in this batch's file list and is untouched in the working tree; the panel sequence and its action count stand. Measured in the harness: the "Desktop app, set up" surface (which renders that panel through `installer/renderer/renderer.js`, itself in this batch under WI-1.5b) changed — old Sizes 9 / Weights 8 / LineHt 10 / Radii 7 / Gaps 12 / Paddings 15 / Small text 26 of 50 / Small targets 0 / Long lines 10, new Sizes 5 / Weights 3 / LineHt 4 / Radii 4 / Gaps 6 / Paddings 12 / Small text 0 of 50 / Small targets 0 / Long lines 4, from the CSS-foundation cards plus `installer/renderer/styles.css`. The action count itself is a separate fact from these style counts and did not move.
- **One approved change.** Counted from the text: unchanged. `packages/gateway-core/src/result.ts` (F16) is untouched in the working tree, and the diff to `packages/mcp-server/src/approval-server.ts` (43 insertions / 6 deletions, checked against `git diff HEAD`) touches only rendering functions (`changeTitle`, `keepOpenInstruction`, `snapshotPlatform`, `statusContent`, `html`), not `operationGet`/`approveOperation` or the "no tool waits" behavior F17 cites; the person must still return to the assistant and say to continue. Measured in the harness: the "Edit list" surface (the review page WI-F.8/WI-F.9a restructure, moving structural fields into Technical details) changed — old Sizes 8 / Weights 4 / LineHt 7 / Radii 2 / Gaps 3 / Paddings 9 / Small text 5 of 14 / Small targets 1 / Long lines 4, new Sizes 6 / Weights 3 / LineHt 4 / Radii 2 / Gaps 3 / Paddings 9 / Small text 0 of 14 / Small targets 0 / Long lines 1.
- **The same kind of change again, same course, same day.** Counted from the text: unchanged. `src/edit-policy.js` is not in this batch's file list and is untouched; no "do not ask again" memory exists yet (that is WI-4.x, not in S1).
- **Ten changes of one kind.** Counted from the text: unchanged. WI-2.3 (batching guidance) is not a card in this batch. `packages/mcp-server/src/approval-server.ts` and `packages/mcp-server/src/morrow-runtime.ts` already carry a `batches` kind and a `BatchWindowScheduler` (from `@morrow/batch-engine`) in the base commit, but that machinery groups the items of one already-batched tool call for display; nothing in this batch adds server-side merging of separately issued same-kind operations into one review, so the row's fact ("1 review if the assistant's tool call already batches the changes; 10 if it issues ten separate operations") stands.
- **Come back the next day, tabs closed.** Counted from the text: **changed.** Old: "`src/service-worker.js` has no path that opens a tab when an operation needs a closed course site (D1a's auto-open is new work, WI-1.2)." New: WI-1.2 is in this batch and is built. `bindingForCommand()` (`connector/extension/src/service-worker.js:5990`) calls `openPlatform()` once, with no consent step, when a command's binding is not runtime-verified, names a saved site, and matches the operation's provider, gated by the `openPlatformWhenNeeded` storage key (default on; a missing key reads as on, confirmed at `:819` and `:5995`). It retries the binding read once after the open, and records an `openPlatformNotice` for the popup's one-line "Morrow Bridge opened Canvas to continue your request." (P2). New `scripts/test/open-platform.test.mjs` (untracked, added this batch) covers the setting-on/one-tab/one-retry, setting-off/no-tab, and no-tab-when-one-exists cases per the spec's WI-1.2 acceptance. This is a genuine "0 clicks" improvement over the old "open the platform by hand" cost, for the case the setting covers; it does not cover a course with no saved site at all, which still throws `platform_open_anchor_missing`.
- **"Can Morrow change anything now?"** Counted from the text: **changed.** Old: "No `chrome.action.setBadgeText` (or similar) call exists anywhere in `connector/extension/src/service-worker.js`." New: WI-1.3 is in this batch and is built. `refreshBadge()` (`:1611`) sets the badge to the review count when `state.reviewsWaiting > 0`, else to "ON" (with the action color) when one or more connections has a valid, unexpired Edit permission (computed for real from `stored.bindings`, `storedPolicies`, and `validEditPermission`, not stubbed), else clears it; it runs at the end of `publishBindings()`, after a policy save or revoke, on the `ui_state` command, and on a `chrome.alarms` alarm at the soonest permission expiry (`BADGE_ALARM_NAME`, wired at `:6149`). `state.reviewsWaiting` itself is still 0 in this batch, because WI-2.4 (R2) is not a card here, so the badge currently only ever shows "ON" or empty, never a review count, until R2 lands; the "glance at the icon" cost for the Edit-permission case is real today. New `scripts/test/toolbar-badge.test.mjs` (untracked, added this batch) covers the three states and the expiry alarm.
- **Stop all access.** Counted from the text: unchanged. `connector/extension/settings/settings.html` and `settings.js` are in this batch's file list (WI-F.10, WI-1.1b, WI-1.4, WI-1.5a, WI-1.6a all touch them), and the cited line numbers moved: the button is now `settings.html:146` (`id="return-plan"`, still disabled until a selection exists), `returnToPlan` is now `settings.js:1233`, and its click handler is now `settings.js:1582`. The selection-then-one-click shape is unchanged; no "every course, every page" selector was added.
- **"What did Morrow change today?"** Counted from the text: unchanged. No history or "recent changes" list was added to `popup/popup.js` or `settings/settings.js` in this batch (WI-6.4 is Phase 6, not in S1).
- **Find one course among 40.** Measured in the harness: unchanged. `PAGE_SIZE = 6` still, now at `settings.js:65` (moved from `:62`); `⌈40/6⌉ = 7` pages stands. Counted from the text: unchanged. `matchingItems()` (`settings.js:421`) still filters on `provider, origin, siteUrl, courseId, courseName, principalId`; no course-code field was added in this batch.
- **Allow a whole area of work.** Not independently re-verified this pass, same status as the baseline row. `src/edit-policy.js` is untouched in the working tree, so the 141-checkbox, F10-catalog-scale fact this row carries is unchanged by this batch; I did not re-walk the category tree in `settings.js`.

Verify command run for this measurement: `node scripts/ux/census.mjs`, from the worktree root, no product file touched by this work item. `packages/mcp-server/dist/` was confirmed newer than `packages/mcp-server/src/` for the two changed source files (`approval-server.ts`, `edit-access.ts`) before running, so the census reads this batch's built output, not a stale build. `df -g /Users/Braden` reported 394 GB free before the run.
