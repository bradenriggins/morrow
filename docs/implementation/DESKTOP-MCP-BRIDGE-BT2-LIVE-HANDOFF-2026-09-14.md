# Desktop, MCP, Bridge, and BT2 live handoff, 2026-09-14

## Exact target

- Machine: Braden's MacBook Air (`Bradens-MacBook-Air.local`, arm64).
- Checkout: `/Users/Braden/Projects/.morrow-worktrees/desktop-mcp-bridge-triple-check-20260914`.
- Branch: `codex/desktop-mcp-bridge-triple-check-20260914`.
- Current committed base: `3c571e2cc4df76fba373148b845f1a43bfa387f4` plus the dirty repair set sealed into the package input manifest.
- Canvas tenant: `https://chcp.instructure.com`.
- Live course: `BIOL 101: General Biology`, Canvas course ID `89585`.
- Live exclusions without separate exact authority: grades and learner messages.

## Current private QA package

The installed build comes from `output/live-bt2-final-package-v25`.

| Artifact | SHA-256 |
| --- | --- |
| `Morrow-1.0.4-mac-arm64.dmg` | `eece931152a202f6628e43b1fefe234cae26a2d05409a294d54c16df893c6bf3` |
| `Morrow-1.0.4-mac-arm64.zip` | `a035e3b7126d8ab2f5b5c2f76e5e1929ba0fc0305bd27ee3cef9e3ccaf57239b` |
| installed `app.asar` | `a3594df959e9f3c8b116c1d8953a4c40473bd2d5f647236f8ba02a4b53d9c026` |
| package input manifest | `44a2776e497235d7d2981a0c88cb240030c43c2bac4e79d7e9aadd377b9b444b` |
| MCP runtime manifest | `642ab910b53000acfe1e3ffa6a96494f1a582766f80e6d06fb12dd1fbb087dc6` |
| release graph | `cfa29a8a7347338d9e6cda41cdf4b9079dd5b4190301b8a944e67eaa024d7377` |

`codesign --verify --deep --strict /Applications/Morrow.app` passed. This package is unsigned private QA. It is not a signed or notarized public release. The previous application remains at `/Applications/Morrow.app.before-bt2-v25-20260914-194413`.

## Current installed state

- Canvas remains signed in. Do not log out.
- Desktop reads one current BT2 binding and shows the preserved first-read receipt.
- Desktop v25 now reports `Update Morrow Bridge` and `Morrow Bridge: Update available`.
- The installed app-owned Bridge worker is the previous sealed build: `01a4c9e0d889b20ce90f122348dd61db83c2fd76f9892976b04cd6065ae5bfab`.
- The v25 sealed Bridge worker is: `8f3cc12d17f6831252404c96d46290411c9e7ebabba151ca48cb207eadf3e09c`.
- No Bridge update is staged yet. The installation record has no pending update.
- Activating v25 requires selecting Update Bridge, reloading the unpacked extension in Chrome, and selecting Check Bridge. Computer Use requires action-time confirmation before the extension update and reload.
- BT2 remains in Plan. Course selection and one-hour Edit access have not been saved. Computer Use requires action-time confirmation before that cloud permission change.

## Live Canvas read evidence

The installed MCP and Bridge completed the full published-read attempt against signed-in BT2:

| Result | Count |
| --- | ---: |
| Published Canvas reads attempted | 215 |
| Successful live reads | 133 |
| Failed attempts | 82 |

Most failed attempts used placeholder object IDs where BT2 had no corresponding fixture. The private seed collector found real folders, assignments, files, modules, pages, and rubrics, then retried 22 operations with exact live identifiers.

The exact-seed retry reached 17 of 22 successfully. Confirmed repairs include:

- `canvas_get_single_user` accepts a learner token in generic path field `id`, resolves it at both privacy boundaries, and succeeds live.
- `canvas_get_single_submission_by_anonymous_id_courses` accepts Canvas opaque anonymous IDs and succeeds live.
- Desktop classifies an exact MCP runtime revision mismatch as repair-required and returns to First read complete after repair.
- Safe error egress distinguishes local `not_sent` failures from Canvas HTTP responses without exposing provider content.

The five remaining exact retries split into two classes:

| Operation class | Live result | Current interpretation |
| --- | --- | --- |
| rubric used locations | deterministic `canvas_request_not_sent` | Bridge reinjection defect; source repair complete, v25 live retry pending |
| assignments for one user | deterministic `canvas_request_not_sent` | Bridge reinjection defect; source repair complete, v25 live retry pending |
| user progress | Canvas HTTP 400 | fixture or feature contract requires exact investigation after v25 activation |
| provisional-grade status by student | Canvas HTTP 400 | requires a moderated-assignment fixture |
| provisional-grade status by anonymous ID | Canvas HTTP 400 | requires a moderated-assignment fixture |

The Bridge repair uses the existing verified Canvas content listener before it attempts reinjection. All 28 lifecycle tests pass, including a forced injection failure with one successful read and zero injection attempts. This is source and simulated proof until the two exact live retries pass through the activated v25 Bridge.

A direct signed-in browser read of `GET /api/v1/courses/89585/users/self/progress` returned Canvas's exact prerequisite failure: the course must use modules with module completion requirements and the target must be enrolled as a student. The current signed-in instructor does not satisfy that learner endpoint. This proves the observed HTTP 400 is a BT2 fixture or role limit, not a Bridge transport failure. A live learner-target retry still needs an enrolled student in a module-based course with completion requirements.

Private receipts remain under ignored `output/live-bt2-final-package-v22/live-proof` and `output/live-bt2-final-package-v23/live-proof`. They can contain course or learner data. Do not stage or publish them.

## Live Canvas write evidence

No live write has been dispatched. BT2 is still Plan-only. The finite write matrix remains blocked on explicit permission to select course `89585` and save one-hour Edit access for non-grade, non-message actions.

Each admitted write must use a Morrow-created disposable fixture and prove:

1. exact plan and target;
2. approval binding;
3. provider dispatch;
4. fresh authoritative Canvas readback;
5. replay refusal;
6. cleanup and cleanup readback.

The matrix must not include grades or learner messages without separate exact authorization.

## Repairs in the current dirty source set

- route-aware generic learner-ID schema and dual-boundary token resolution;
- opaque Canvas anonymous-ID schema;
- repair-required Desktop state for exact MCP runtime mismatch;
- closed safe provider-failure projection;
- existing-listener-first Canvas probe and read execution;
- read-only Desktop detection of a sealed app-owned Bridge update;
- repair-required Desktop lifecycle when a live unpacked extension outlasts its missing or damaged app-owned folder;
- generated catalog and focused regressions for every repair.

The defect ledger records these as rows 419 through 425.

## Verification completed after the latest repairs

- extension lifecycle: 28 passed;
- focused Desktop controller, contract, lifecycle, and view suites: 120 passed;
- earlier gateway privacy suite: 151 passed, 3 skipped;
- earlier Canvas connector suite: 65 passed;
- earlier Canvas connector gateway integration: 23 passed.
- complete script gate after row 425: 927 passed, 1 skipped, 0 failed;
- complete Desktop gate after row 425: 411 passed, 1 skipped, 0 failed;
- Desktop updater gate after row 425: 7 passed, 0 failed;
- row 425 focused Desktop assistant, controller, and view suites: 125 passed, 0 failed;
- defect-ledger integrity after row 425: 3 passed, 0 failed;
- `git diff --check` after row 425: passed.

The complete `pnpm test` gate is green for the current source. It must run once more after the live repair loop if that loop changes source.

## Required next actions

1. Obtain action-time confirmation for the Bridge update and Chrome extension reload.
2. Select Update Bridge in installed v25.
3. Reload Morrow Bridge in the existing signed-in Chrome profile. Do not log out.
4. Select Check Bridge and verify exact active-folder readback, no pending update, and First read complete.
5. Rerun the two exact `not_sent` reads. Require provider dispatch and classify the provider result.
6. Retry user progress only with an enrolled student in a course that has module completion requirements. Exercise the two provisional-grade status routes only with a moderated assignment fixture; they remain outside the current no-grade live scope.
7. Obtain action-time confirmation for selecting course `89585` and saving one-hour Edit access.
8. Execute the finite non-grade, non-message write matrix with authoritative readback, replay refusal, and cleanup.
9. Update this handoff and the defect ledger with final live receipts and any new root fixes.
10. Run the complete repository gate, inspect the final diff, commit the repair set, push the branch, and verify the remote SHA.

Completion is still open. Source tests do not replace live provider readback, and no write is proven until its exact Canvas postcondition and cleanup are read back.
