# Morrow 1.0 stopping-point handoff

Status: source freeze for commit and push on 6 September 2026.  
Checkout: `/Users/example/Projects/.morrow-worktrees/example-worktree`  
Branch: `codex/example-worktree`  
Base before this work: `6c15a421a519ea94fd868aef1b3bb808a995f145`

This is a stopping point. It is not a Morrow 1.0 completion or release claim. The active product scope remains in [MORROW-1.0-COMPLETION-GOAL.md](MORROW-1.0-COMPLETION-GOAL.md), and the detailed open-work ledger remains in [MORROW-REMAINING-WORK.md](MORROW-REMAINING-WORK.md).

## Controlling recent direction

Braden's latest messages are:

> NO DUDE. I HAVE EXAMPLE QUOTED TEXT. WE HAVE TO USE THOSE.

> Get to a stopping point. Get the work commited and pushed. Write a handoff that includes my recent messages.

> I dont want the launch video and marketing stuff in the morrow repo. Just the public codebase

The first message corrects the earlier conclusion that New Quiz and Item Bank repair paths were unavailable. Do not repeat that conclusion. Use the harvested ExamplePlatform contracts described below. The second message froze new feature work and required this branch to be committed and pushed. The third message removes the website, launch film, and marketing documents from the repository. Those files stay on the local disk and are ignored by git. Do not add them back to this repository.

## What is in this source freeze

- The Canvas connector now uses generated operation-admission and saved-result-readback contracts across the catalog, service worker, content executor, and MCP runtime. It includes guarded course composition, Canvas file transfer, Canvas Inbox planning, Classic Quiz submission aggregates, program inventory and audit work, exact Edit categories, shared runtime ownership, durable result bindings, and stronger uncertain-effect handling.
- Canvas accessibility repair fixtures cover Page, Assignment, Discussion, Classic Quiz description, and supported direct or nested New Quiz fields. Canvas text or HTML file reads and reviewed file transfers use a separate local opt-in and Chrome file-host permission. Customer Canvas file hosts, PDF and Office content, Classic questions, Stimuli, and safe existing-bank mutations remain incomplete.
- Moodle adds broad native browser catalog and executor coverage, learner-safe roster and submission projections, Forum reads, group reads, Quiz attempt summaries, Assignment submission summaries, gradebook work, Resource file transfer, more module settings, question inspection, and SCORM package creation. The SCORM flow checks the complete ZIP central directory, requires a root `imsmanifest.xml`, saves one hidden package, and compares saved bytes. It does not implement the player. Two SCORM tracking reads, `moodle_get_scorm_attempt_summary` and `moodle_get_scorm_learner_report`, were added after the freeze; a stock Moodle site refuses them, because it does not enable its SCORM web-service functions for the browser AJAX endpoint.
- The Forum activity-summary read was isolated at the freeze. It is now connected: `moodle_get_forum_activity_summary` is in the generated Moodle browser catalog, `connector/extension/src/service-worker.js` routes it, and `packages/mcp-server/test/moodle-forum-activity-summaries.integration.test.ts` proves the Full MCP surface exposes one aggregate-only read that drops every Forum identifier. No signed-in Moodle site has run it.
- The official Blackboard REST package and a private gateway path now exist. What the public MCP exposes depends on the tool surface. With `toolSurface: "full"` it lists `morrow_blackboard_health`, every Blackboard read, and the one plan operation, `morrow_plan_blackboard_content_patch`. With `toolSurface: "compact"`, which is what the desktop app writes (`packages/client-config/src/index.ts:599`), no catalog tool is registered under its own name: each read answers under that same name through `morrow_capability_read`, `morrow_catalog_search` finds it, and the plan operation is a separate tool in both surfaces. The private apply and verification helpers are undiscoverable in both surfaces, and no Blackboard write is reachable through `morrow_capability_change`. `packages/mcp-server/test/blackboard-surface-reachability.test.ts` holds both surfaces to that. The gateway validates the signed grant and exact plan digest before any provider read. Tests prove forged, cancelled, unapproved, and replayed attempts send no PATCH; the valid path sends one PATCH and performs a fresh comparison. Every Blackboard result states its own execution state, so a refusal raised before the request settles the operation as failed, and only a failure from the request onward settles it as `applied_or_unknown`. No live Blackboard tenant was tested.
- The Electron desktop app, guided Mac and Windows installer source, exact assistant-app detection, shared-owner runtime monitor, sealed payload manifest, Bridge coordination, update and rollback engine, and local Blackboard secret transaction are included. Windows detects ChatGPT only from exact signed MSIX identity fields and fails closed.
- The public website source, the launch film, and the marketing documents are not in the repository. The `website/` and `launch/` directories were tracked before this freeze and are removed from the index by this commit. They remain on the local disk and are listed in `.gitignore`. The live website was already published and hash-checked before this freeze. The film is silent by design and passed full decode and HyperFrames checks. Phone work remains deferred and local only.
- The product and public documentation now use the current Morrow Bridge name, current course-selection and Edit model, current privacy boundaries, and explicit evidence limits.

## New Quizzes and Item Banks: corrected next implementation

ExamplePlatform was inspected read-only through `ssh example-lms-vps`. The checkout was `/opt/example-attestation-repo` at `06e0eb5d4495413664479c229897aceea3437a91`. The authoritative implementation sources are:

- `scripts/team/mcp/tools/newquizzes.py`
- `example-kit_automation/nq_client.py`
- `example-kit_automation/nq_item_bank_sdk.py`
- `example-kit_automation/item_bank_governance.py`
- `docs/canvas/item-banks-sdk.md`

Use these contracts:

- New Quiz assignments, settings, and items use `/api/quiz/v1/...`.
- Item Bank management uses the private `/api/banks/...` surface inside a course-bound Item Banks LTI session.
- Acquire and use the private Item Banks credential only inside the exact authenticated Item Banks frame. Never move it into extension storage, the bridge protocol, MCP output, logs, or client configuration.
- A quiz bank draw also uses the exact selected assignment's builder launch and keeps its builder credential inside that frame.

The 7 September guarded-write plan in this handoff is superseded by the 8 September complete-contract audit and builder-credential follow-up.

### Current boundary on 8 September 2026

1. **Seven reads are implemented and need live proof.** Six use the Item Banks frame. The seventh lists complete quiz entries and bank draws through the exact selected assignment's builder frame.
2. **The fan-out reader records entry counts, observed share rows, and selected-course quiz uses.** Current share rows carry a private context UUID that Morrow cannot map to a numeric Canvas course id from proved data. Its record always has `complete: false`. It is review context and never an authority grant or write precondition.
3. **All nine owner-write shapes are held before provider I/O.** Bank creation lacks a recoverable course-association transaction. Existing-bank changes lack complete downstream reach. The random bank draw lacks durable interruption recovery.
4. **The image alternative-text planner depends on the held complete-item update.** It stops before a bank read or PATCH.
5. **The attended live plan covers all 16 operations but authorizes no provider write under the current audit assignment.** Local fixtures prove contract behavior only. No Morrow-connected tenant has proved the private Item Banks or builder routes.

Review the exact harvested New Quiz item contract before adding Stimulus repair. The correction establishes that an API source exists. It does not prove that every Stimulus field has a complete preservation and dependency contract.

## Verification

Every line below names the command that produced it and the date it ran. A number without a command and a date is not evidence. Work continues on this branch, so re-run a line before you rely on it.

### Re-run in this checkout on 7 September 2026

Build once first: `pnpm -r --if-present build`.

- `pnpm --dir installer --ignore-workspace test`: 165 of 165 pass.
- `node --test installer/test/runtime-monitor.test.mjs`: 6 of 6 pass.
- `pnpm --dir packages/gateway-core exec vitest run`: 59 of 59 pass in 9 files.
- `pnpm --dir packages/blackboard-learn-api exec vitest run`: 93 of 93 pass in 10 files.
- `pnpm --dir packages/mcp-server exec vitest run test/blackboard-gateway.integration.test.ts test/blackboard-dispatch-state.integration.test.ts test/blackboard-approval-review.test.ts test/blackboard-course-audit.test.ts test/blackboard-egress-scope.test.ts test/blackboard-surface-reachability.test.ts`: 18 of 18 pass in 6 files.
- `pnpm --dir packages/mcp-server exec vitest run test/canvas-classic-quiz-submissions.test.ts test/canvas-classic-quiz-submissions.integration.test.ts`: 3 of 3 pass. `node --test scripts/test/canvas-classic-quiz-submission-read.test.mjs`: 2 of 2 pass.
- `pnpm --dir packages/mcp-server exec vitest run test/moodle-scorm-reports.test.ts test/moodle-scorm-reports.integration.test.ts`: 6 of 6 pass. `node --test scripts/test/moodle-scorm-executor.test.mjs scripts/test/moodle-scorm-report-read.test.mjs`: 4 of 4 pass. The generated Moodle browser catalog now holds 116 operations, 7 of them SCORM.
- `pnpm --dir packages/mcp-server exec vitest run test/moodle-forum-activity-summaries.test.ts test/moodle-forum-activity-summaries.integration.test.ts`: 4 of 4 pass. `node --test scripts/test/moodle-forum-activity-summary-read.test.mjs`: 2 of 2 pass.
- `pnpm --dir packages/mcp-server exec vitest run test/canvas-connector.integration.test.ts test/local-owner.integration.test.ts test/program-scale.integration.test.ts test/batch.integration.test.ts`: 44 of 45 pass; the run took 57 s and 55 s on two attempts. The one failure is `test/batch.integration.test.ts` > "removes an audit target whose exact identifier would change during learner redaction". The course inventory now adds a `syllabus` target to every course, and that test still expects `audit_children: []`. The redacted Page identifier the test was written to catch is still removed.
- `pnpm --dir packages/mcp-server exec vitest run test/multi-client.integration.test.ts test/activity-tools.test.ts test/batch-progress.test.ts test/requested-by.test.ts test/batch-window-scheduler.test.ts`: 36 of 36 pass in 5 files. `test/multi-client.integration.test.ts` runs two real `morrow-mcp` child processes, from two project folders and under two reported client names, through one local owner and one Bridge fixture.

`pnpm check` was not run in this checkout. It cannot pass while the one failure above stands, because `packages/mcp-server` is inside `pnpm -r --if-present test`.

### Earlier tree, 6 September 2026

These numbers describe the tree at the source freeze. Nothing in this checkout reproduces them, and the re-runs above replace them. Do not restate them as current results.

- Installer 67 of 67; runtime-monitor 6 of 6; gateway-core 59 of 59; Blackboard package and gateway 16 of 16; Classic Quiz submission aggregate 3 MCP and 2 browser; SCORM 11 browser, 11 connector-runtime and a 103-row catalog check with 3 SCORM operations; Forum activity summary 1 browser and 2 MCP unit tests.
- Main film: complete H.264 decode; 1920 by 1080, 30 fps, 1,260 frames, 42 seconds; HyperFrames returned 0 errors and 63 of 63 contrast checks. The film is no longer in this repository. `launch/` stays on the local disk and is ignored by git, so this result cannot be repeated from a checkout.
- The desktop payload allowlist capture succeeded with 50 files at Bridge version 1.0.2. The Bridge version is still 1.0.2, but the audited allowlist in `scripts/package-mcp-bundle.mjs` now names 63 files, so 50 is the freeze's number and not this checkout's. `captureBridgeRelease()` compares the extension folder against that list exactly and refuses on any difference; `node --test scripts/test/bridge-release-provider-scope.test.mjs` passed here on 7 September 2026, and it is the current answer for whether the two still match.

The final `pnpm check` result and pushed commit are reported with the handoff in the branch tip. If that broad check fails, treat its exact output as an open gate. Do not convert focused checks into a release claim.

## Known blockers and limits

### Canvas

- Complete the New Quiz and Item Bank work from the harvested ExamplePlatform contracts above.
- Finish the program-wide accessibility ledger and learner-rendering checks.
- Complete semantic scope or dependency contracts for the held catalog writes and exact readback for remaining direct-course operations.
- Prove Canvas file permission and transfer on an authorized customer Canvas file host. PDF, Office, and other binary content remain manual or unread.
- Preserve unresolved-operation locks. A browser can resend a POST after a dropped connection even when Morrow makes one explicit dispatch, so one explicit dispatch must never be read as exactly one provider effect. [BROWSER-POST-TRANSPORT-LIMIT.md](BROWSER-POST-TRANSPORT-LIMIT.md) holds the measurement and the checks that follow from it.

### Moodle

- The Forum activity summary is integrated through the catalog, service worker, runtime projection and Full MCP test. It still needs a signed-in Moodle result.
- Complete the SCORM player functions, and obtain authorized native proof for the package writes and for the two tracking reads a stock Moodle site refuses.
- Finish every core module, all authorable core question types, cross-cutting learner functions, gradebook writes, administration, roles, and live proof required by [MOODLE-FULL-FUNCTIONALITY.md](MOODLE-FULL-FUNCTIONALITY.md).
- Keep Question Bank writes held until direct, latest-version, and random-reference impact can be scoped safely.
- The attempted extra SCORM gateway test exceeded its 45-second limit and was reverted. The dated SCORM lines under [Verification](#verification) are the current evidence.

### Blackboard

- No live tenant or course result exists. Keep the public product status as live-unverified.
- The desktop app now writes the Blackboard course bindings a person selects, through the same rollback and hash-confirmed readback the credential transaction uses, and shows the status "Blackboard REST API configured. Live Blackboard access has not been tested." It holds one Blackboard connection: saving a different site replaces the saved configuration and removes the secret saved for it, and the form states that consequence with the saved site named before the save. Setup still asks for the integration account id and the course id. `blackboard_list_my_courses` exists, but it resolves an already-connected course binding before it reads, and no route reads the authenticated account without one, so setup can neither show the account Blackboard resolves nor list that account's courses. Both need a tenant-scoped read in `packages/blackboard-learn-api`; `installer/test/contract.test.cjs` also holds `installer/shared/blackboard.cjs` to a filesystem-only transaction that makes no network request.
- Obtain an authorized tenant and local integration credentials before a live test. Keep secrets in the app-owned private transaction.
- Verify real principal, tenant, course, entitlement, write, readback, cancellation, and replay behavior.

### Desktop and release

- Rebuild the sealed desktop payload from this exact source freeze.
- Run the installed Windows DACL and gateway-health smoke. CI run `34054748342` only showed that the stock runner had no relevant OpenAI package or Morrow configuration.
- Supply signing credentials. Run real signed old-to-new update, interruption, rollback, repair, and uninstall proofs on Mac and Windows.
- Produce final install artifacts and exact hashes. Complete notarization and Chrome Web Store work where required.
- Do not publish source or claim a complete release from this commit.

### Evidence and marketing

- The live website and film are product surfaces, not proof that all depicted or described workflows are available.
- Do not claim automatic filtering of all student PII. The implemented boundary covers known structured identities and text against a complete roster and refuses output when required evidence is incomplete.
- Do not claim full Canvas, Moodle, Blackboard, Windows, phone, or cross-client parity.
- Phone screenshots and drafts under `launch/video/phone/` remain local, deferred, and outside this commit.

## Local files intentionally left outside the commit

Preserve these files locally. They contain the website, launch film, marketing documents, generated caches, private packages, test artifacts, deferred phone work, browser state, or machine-specific client configuration. All of them are now in `.gitignore`:

- `website/` (previously tracked; removed from the repository by this commit)
- `launch/` (previously tracked; removed from the repository by this commit; includes `launch/video/phone/` and `launch/video/snapshots/`)
- `.agents/product-marketing.md`
- `docs/implementation/MORROW-WEBSITE-BRIEF.md`
- `docs/research/MORROW-MESSAGING-AND-RESPONSIVE-TYPE-2026-09-06.md`
- `.codex/config.toml` and `.gemini/settings.json` (rendered client configuration with absolute local paths)
- `.playwright-cli/`
- `artifacts/desktop-runtime-cache/`
- `artifacts/privateMcpBundle/`
- `artifacts/previews/`

Do not delete them as cleanup. Inspect provenance and rights before using any of them in a public artifact. `config/source-origin-ledger.json` still lists the removed `launch/` documents; regenerate the ledger with `pnpm source-origin:generate` before the next release receipt.

## Resume order

1. Fetch `codex/example-worktree` and read this file, [MORROW-REMAINING-WORK.md](MORROW-REMAINING-WORK.md), and the current source before changing it.
2. Re-run `pnpm check` if the branch tip or dependencies changed.
3. Rebuild the sealed payload and complete native Mac and Windows install, update, rollback, repair, and uninstall proof.
4. Use the 8 September 16-operation Item Bank contract. Keep fan-out results labeled as observed and incomplete, and do not treat local fixture proof as live provider proof.
5. Integrate the isolated Moodle Forum activity summary, then continue the explicit Canvas, Moodle, Blackboard, scale, and phone blockers.
6. Recheck public claims against authoritative saved results before any release or publication.

Do not start Docker. Do not automate the system Chrome application. Use SSH only for ExamplePlatform. Do not retry an uncertain LMS write.
