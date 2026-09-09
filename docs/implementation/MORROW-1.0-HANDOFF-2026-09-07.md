# Morrow 1.0 handoff, 7 September 2026

Status: workflow stopping point. Not a completion claim. Not a release claim.
Checkout: `/Users/example/Projects/.morrow-worktrees/example-worktree` (git worktree of `/Users/example/Projects/Morrow`)
Branch: `codex/example-worktree`
HEAD: `6c15a421a519ea94fd868aef1b3bb808a995f145` (unchanged since the 6 September freeze; nothing has been committed since)
Written by: Claude Code (Fable 5.1), session `session_016T4AxnKxrW6ikURJZ7XruT`, continued after an account switch as `session_0113X39T2QhVJQWZDfo79YsQ`
Previous handoff: [MORROW-1.0-HANDOFF-2026-09-06.md](MORROW-1.0-HANDOFF-2026-09-06.md) (still accurate for the freeze itself; superseded by this file for everything after)

This document is long on purpose. Section 0 is the short version. Everything after it is evidence, exact paths, exact commands, and exact open questions. The machine-generated per-item ledger is in `work/handoff-2026-09-07/APPENDIX-A-work-items.md`, and every agent's full report is in `work/handoff-2026-09-07/main-journal-merged.json` and `website-journal.json`.

---

## 0. Read this first

1. **Nothing is committed and nothing is pushed.** The 6 September freeze is staged in the git index. Everything the workflows did on 6 and 7 September is unstaged on disk on top of it. `git status` shows about 200 modified files, about 250 new files, and 13 deletions, all unstaged. Section 2 explains the exact layering and how to commit it.
2. **Implementation is complete for the enumerated scope; independent verification never ran.** Seven Opus 5 lane analyses produced 201 work items. At the stop, 198 are reported done by their implementing agents and 3 are partial with the agent's own statement of what remains (Section 5.9). Every "done" is an agent's own claim backed by the focused tests it ran; the planned Opus verification round, the Fable 5.1 verification round, the final Opus checks, the serialized broad gate, the completeness critic, and the ledger update **did not run** (Section 4.4 says why, Section 16 says how to run them).
3. **The broad test gate is red and has not been run end to end since the freeze.** Known reds are listed in Section 7.2. Several are stale documentation counts that a single reconciliation pass fixes; one is a genuine Canvas batch defect; two are integration tests that time out on this machine.
4. **The website was rewritten by a separate Opus 5 workflow** from a 222-finding audit and a 1,725-line plan, and its own three adversarial verifiers then reported 54 findings (2 critical, 9 high) that were **not fixed** because the run was stopped before its fixer and final check (Section 9.7 lists them). Every assistant turn in every sample conversation is labeled "Your Assistant using Morrow" and the website test file is green (44 tests, 43 pass, 1 skipped). The site lives only on local disk (`website/`, gitignored on Braden's instruction) and has **not** been deployed. Fix the 54 findings before deploying.
5. **The New Quizzes and Item Banks correction is implemented from the ExamplePlatform harvest.** The contract is in `docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md`; all 20 lane items are done. Section 6.
6. **Braden's decisions, in order of urgency:** (a) commit identity and how to get past the pre-commit hook (Section 2.5); (b) whether the `README.md`/`LIMITATIONS.md` Moodle count reconciliation is done by hand or by re-running the workflow's ledger stage (Section 8); (c) website deployment (Section 9.6); (d) the GitHub repository is returning 404 while the live site says "open source" (Section 9.5); (e) signing credentials, a Blackboard tenant, and a Windows host, which no agent can supply (Section 15).

---

## 1. Braden's controlling messages, verbatim, in order

These are the instructions this work followed. Later messages override earlier ones where they conflict.

Carried over from the 6 September freeze:

> NO DUDE. I HAVE EXAMPLE QUOTED TEXT. WE HAVE TO USE THOSE.

> Get to a stopping point. Get the work commited and pushed. Write a handoff that includes my recent messages.

This session, 6 September:

> Find docs/implementation/MORROW-1.0-HANDOFF-2026-09-06.md. Read it. I need you to pick up where the project left off. The local codex session ID is 01a074d1-064d-78a2-b4b9-ee222073fcd4

> I dont want the launch video and marketing stuff in the morrow repo. Just the public codebase

> I need you to analyze all remaining work and evaluate the existing work. Then I need you to create a dynamic workflow of Opus 5 agents on max to implement all remaining work. Many many agents. Then another round of opus 5 verification agents. Then a layer of 3 Fable 5.1 verification agents. Then another round of Opus 5 agent checks. By the end of this, we should have a perfect website, a perfect windows and Mac desktop app, a perfect and functional MCP with ALL canvas and Moodle and Blackboard tools, including canvas new quizzes and item banks APIs from example-lms-vps, and the Morrow Bridge working perfectly for Canvas, BlackBoard, and Moodle. The entire bridge working perfectly. Multiagent workflows working perfectly through Morrow. morrow needs to be groundbreaking and revolutionairy. Always keep what is the best user experience for users in mind.

> Stop the damn gate and shit. Stop the pushes. Just get fucking work done

> Bro, what the fuck are you doing? I don't see any fucking work getting done. You're starting to piss me the fuck off already. I don't give a fuck what's going on. Stop the fucking shit. Start getting work done.

> I only see 4 analyze agents???

> I NEED YOU TO RAISE IT SUPER HIGH

> I'm going to sleep. It's very important that you continue to monitor and ensure that by the time I wake up, the desktop app, the MCP, the Bridge, and the website are all perfect. You need to set it up so that you can detect any failures and make sure it all stays on track.

This session, 7 September:

> GET IT FIRED UP AGAIN

> Please get the workflow started back up. Please get this all finished up. Get a workflow of Opus agents to finish this all up please.

> Can we have another smaller Opus 5 workflow that is checking the website for any design inconsistencies, empty space, repeated elements, language that is too technical, etx. I also want the conversation examples, instead of being labeled as "Morrow", label them all "Your  Assistant using Morrow" instead. I really need to ensure that the value of Morrow is truly communicated. Also there are lots of outdated info, like proper Moodle and BlackBoard support is missing. And the installation process is outdated. We need to ensure the entire site is up to date, formatted and structured simply and beautifully. Clear communication. The sample conversations also need to be analyzed to ensure they sound real, inpactful, and they communicate Morrow's capabilities well.

> I need you to get both workflows to a stopping point. and then write an incredibly detailed, incredibly detailed, like, so fucking detailed hand off document.

Interpretation notes that matter:

- "Stop the pushes" and "Stop the damn gate" were honored for the rest of the session: no `git commit`, no `git push`, and no whole-suite run by the controller. The workflow's own final gate stage never reached execution (Section 4.4).
- "Just the public codebase" was implemented by removing `website/`, `launch/`, `.agents/`, `.codex/`, `.gemini/`, and two marketing documents from the index and adding them to `.gitignore` (Section 2.3). The files remain on disk.
- The conversation label was applied as `Your Assistant using Morrow` (single space; the double space in the message was read as a typo). The capital A is Braden's; the stylesheet's `text-transform: uppercase` on speaker labels was removed so the string renders exactly as written.

---

## 2. Repository state, exactly

### 2.1 The three layers on disk

| Layer | What it is | How to see it |
| --- | --- | --- |
| `HEAD` = `6c15a421a` | "Read Moodle Resource file metadata and define full Moodle scope", 5 September, author `Morrow Test <morrow-test@example.invalid>` | `git log -1` |
| **Index (staged)** | The 6 September source freeze that the Codex session prepared and this session trimmed: 304 paths staged (271 added or modified, 33 deletions). The deletions are the 14 `website/` and 19 `launch/` files that were tracked at HEAD and are now removed from the repository per Braden. | `git diff --cached --stat` |
| **Working tree (unstaged)** | Everything the two workflows did on 6 and 7 September, plus the 6 September handoff edit and this handoff. | `git diff --stat`, `git ls-files --others --exclude-standard` |

Counts at the time of writing (regenerate with the commands; they move if anything else runs):

```
git diff --cached --name-only | wc -l          # 304 staged (freeze)
git diff --name-only | wc -l                   # 199 modified, unstaged (workflows)
git diff --name-status | grep -c '^D'          # 13 deleted, unstaged (workflows)
git ls-files --others --exclude-standard | wc -l   # 273 new, unstaged (250 from workflows + 23 in work/handoff-2026-09-07/)
```

Unstaged line delta at the stop: about 43,700 insertions and 9,300 deletions across the 199 modified files, before counting the new files.

### 2.2 What the workflows deleted (unstaged deletions)

All 13 were deliberate, each by a work item that recorded its reason:

- `main.cjs`, `preload.cjs`, `renderer.js` at the repository root: stale duplicates of `installer/main.cjs`, `installer/preload.cjs`, `installer/renderer/renderer.js` that required a `./shared/contract.cjs` which does not exist at the root and could never run (desktop-05; guard test `scripts/test/desktop-entrypoint-uniqueness.test.mjs` fails if they return).
- `connector/extension/src/blackboard-session.js` and `scripts/test/blackboard-session.test.mjs`: the retired Blackboard *browser* route. Blackboard ships only through the official Anthology Learn REST package (ux-20, blackboard lane).
- `connector/extension/brand/FONT-LICENSE.txt`, `GoogleSansFlex-latin.woff2`, `morrow-knot-dark.png`, `morrow-wordmark-dark.png`, `morrow-wordmark.png`, `morrow.png`, and `installer/assets/morrow-wordmark.png`, `morrow-wordmark-dark.png`: the pre-6-September font and raster wordmarks replaced by Manrope and the live-text wordmark per `docs/brand/MORROW-BRAND.md` (ux lane).

### 2.3 What is intentionally outside the repository (gitignored, kept on disk)

Added to `.gitignore` this session, per "just the public codebase":

```
launch/                 # film source, storyboard, renders, phone drafts, snapshots (was tracked; removed from index)
website/                # the public site source (was tracked; removed from index)
.agents/                # product-marketing.md, Braden's positioning brief
.codex/                 # rendered Codex client config with absolute local paths
.gemini/                # rendered Gemini client config with absolute local paths
.playwright-cli/        # browser traces
artifacts/desktop-runtime-cache/
artifacts/privateMcpBundle/   # 1.2 GB
artifacts/previews/
docs/implementation/MORROW-WEBSITE-BRIEF.md
docs/research/MORROW-MESSAGING-AND-RESPONSIVE-TYPE-2026-09-06.md
```

Do not delete any of these as cleanup. `website/` is the only copy of the rewritten site (Section 9). `launch/video/phone/` (261 MB) and `launch/video/snapshots/` are Braden's deferred phone work.

Consequence to know about: `config/source-origin-ledger.json` still lists the 21 `launch/` paths and 14 `website/` paths that are no longer tracked. Regenerate it with `pnpm source-origin:generate` before any release receipt. `SOURCE-ORIGIN.md` was edited by a workflow agent and should be re-read after that regeneration.

### 2.4 Files the workflows created (unstaged, new)

By directory (exact list: `git ls-files --others --exclude-standard`):

| Directory | New files | What they are |
| --- | --- | --- |
| `scripts/test/` | 79 | executing node:test suites, one or more per work item |
| `packages/mcp-server/` | 62 | new source modules and vitest suites (program ledger, Blackboard gateway pieces, Moodle projectors, batch progress, bridge handshake tests, and more) |
| `connector/extension/` | 47 | new Moodle executors (one file per module family), Canvas semantic-target and write-outcome modules, item-bank frame matcher, popup view, render-check |
| `packages/blackboard-learn-api/` | 32 | operations by family (`src/operations/*.ts`) and their mocked-HTTPS tests |
| `installer/test/`, `installer/shared/` | 12 | executed installer tests (replacing source-regex tests), controller and setup-view modules |
| `docs/implementation/` | 6 | `BLACKBOARD-REST-SCOPE.md`, `CANVAS-ADMISSION-CLASSES.md`, `EDIT-CATEGORY-CONTRACT.md`, `FIRST-RUN-STATE-INVENTORY.md`, `ITEM-BANK-LIVE-PROOF-PLAN.md`, `MOODLE-LIVE-PROOF-CHECKLIST.md` |
| `docs/research/` | 1 | `CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md` (the ExamplePlatform harvest) |
| `scripts/` | 5 | `blackboard-catalog.mjs`, `canvas-admission-report.mjs`, `moodle-live-proof.mjs`, `release-signing-preflight.mjs`, `run-browser-harnesses.mjs` |
| `artifacts/` | 2 | `canvas-api/canvas-admission-report.json` (generated, drift-tested), `blackboard/blackboard-rest-catalog.json` |
| `.github/workflows/` | 1 | `windows-chatgpt-inventory.yml` |
| `work/handoff-2026-09-07/` | 23 | this handoff's evidence (Section 3.3) |

`package.json` gained scripts: `test:desktop`, `test:desktop:update`, `test:browser`, `test:browser:attended`, `canvas:admission:report`, `canvas:admission:check`, `release:signing:preflight`; `test` now ends with `&& pnpm test:desktop`, so the installer suites are inside the authoritative gate for the first time (desktop-04).

### 2.5 Git identity, hooks, and remote (Braden's decisions)

- **Identity.** `/Users/example/Projects/Morrow/.git/config` sets `user.name = Morrow Test` and `user.email = morrow-test@example.invalid` at the repository level, which overrides the global `Braden Riggins <hello@example.com>`. Every commit on this branch since `d71fd585f` carries the test identity; `main` carries Braden's. Several test files set the same test identity inside temporary repositories they create (for example `scripts/test/release-gates.test.mjs:131`), which is presumably how it leaked into the real config. Decide before committing: `git -c user.name='Braden Riggins' -c user.email='hello@example.com' commit …`, or fix the repository config once.
- **Pre-commit hook.** This worktree has `core.hooksPath=.githooks` in its worktree config, and `.githooks/pre-commit` here runs `pnpm test` (the whole suite, with no skip variable). Two commit attempts on 6 September were killed because the hook started the full gate, which is currently red (Section 7.2). Options: run the gate to green first and commit normally; or commit with `git -c core.hooksPath=/dev/null commit …` and say so in the message. (The `MORROW_SKIP_PRECOMMIT=1` variable belongs to the *main checkout's* hook at `extension/.githooks/pre-commit` and has no effect here.)
- **Remote.** `origin = https://github.com/example-owner/morrow.git`. The branch `codex/example-worktree` does not exist on origin. `gh auth status` shows the `example-owner` account logged in with `repo` scope. The website truth audit found that `github.com/example-owner/morrow` returns HTTP 404 to an unauthenticated request while the live site says "free and open source" (Section 9.5); either the repository is private or the URL is wrong.
- **Stash.** The stash stack is shared with every worktree. Nothing was stashed this session.

### 2.6 How to commit the two layers

Suggested, not executed:

```sh
cd /Users/example/Projects/.morrow-worktrees/example-worktree
# 1. the freeze (already staged)
git -c user.name='Braden Riggins' -c user.email='hello@example.com' -c core.hooksPath=/dev/null \
  commit -F docs/implementation/commit-message-freeze.txt      # write the message first, or use -m
# 2. the workflow layer
git add -A                                                     # review `git status` first; work/handoff-2026-09-07 is included
git -c user.name='Braden Riggins' -c user.email='hello@example.com' -c core.hooksPath=/dev/null \
  commit -m "Implement the Morrow 1.0 lane work items from the 7 September workflow (unverified)"
# 3. push when ready
git push -u origin codex/example-worktree
```

Two commits keep the freeze reviewable on its own. A draft freeze message is in Section 2.7. If you prefer one commit, `git add -A` first.

### 2.7 Draft commit message for the freeze layer

```
Freeze the Morrow 1.0 stopping point across Canvas, Moodle, Blackboard, and desktop

Source freeze requested on 6 September 2026. This is a stopping point, not a release.

- Canvas: generated operation-admission and saved-result-readback contracts across the
  catalog, service worker, content executor, and MCP runtime; guarded course composition;
  file transfer and text/HTML file reads behind a local opt-in and a Chrome file-host
  permission; Inbox planning; Classic Quiz submission aggregates; accessibility repair
  fixtures for Page, Assignment, Discussion, Classic Quiz description, and supported New
  Quiz fields.
- Moodle: native browser catalog and executor coverage, learner-safe roster and submission
  projections, Forum and group reads, Quiz attempt and Assignment submission summaries,
  gradebook work, Resource file transfer, question inspection, and SCORM package creation.
- Blackboard: official REST package and a private gateway path. No live tenant was tested.
- Desktop: Electron app, Mac and Windows installer source, assistant-app detection,
  shared-owner runtime monitor, sealed payload manifest, Bridge coordination, update and
  rollback engine.
- Repository scope: website/, launch/, and the marketing documents are removed from the
  repository at Braden's direction and kept on local disk. Rendered client configs and
  local caches are ignored.

Handoff: docs/implementation/MORROW-1.0-HANDOFF-2026-09-06.md. The broad gate was not
run for this commit.
```

---

## 3. Timeline of this session (America/Chicago)

| When | What happened |
| --- | --- |
| Sat 6 Sep 14:46 | Session starts on the MacBook Air. Read the 6 September handoff and the Codex transcript `01a074d1-064d-78a2-b4b9-ee222073fcd4`. Found the Codex session had written the handoff but had **not** committed or pushed; its `pnpm check` was still running when it was interrupted. |
| 14:48 to 15:05 | Inspected the staged freeze (338 paths, 27.8 MB, secret scan clean apart from the two test-fixture PEMs). Braden: no launch video or marketing in the repo. Removed `website/`, `launch/`, `.agents/`, `.codex/`, `.gemini/`, and two marketing docs from the index; added them to `.gitignore`; updated the 6 September handoff to record that. Two commit attempts were killed by Braden because the worktree pre-commit hook started the whole test suite; a serialized broad-gate run was killed for the same reason. |
| 15:08 | Main workflow run 1 (`wf_b53fdf26-f62`) launched: 7 lane analyses in waves of 4, then implementation, Opus verify, Fable verify, final checks, gate, critic, ledger. |
| 16:02 | Analysis complete: 201 work items, 146 evaluation findings (18 critical, 53 high, 58 medium, 17 low). Implementation began at 4 concurrent. |
| 21:11 | Status review for Braden: 52 items done. Braden: raise concurrency "super high". |
| 21:19 to 21:20 | Run 1 stopped and resumed with the same run ID, replaying the 63 finished agents from cache and switching to a rolling pool of 8 (the per-workflow cap on this 10-core machine). |
| 22:37 | Overnight monitor installed (`monitor.py` plus a self-scheduled wakeup every 30 minutes). 73 items done. |
| Sun 7 Sep ~00:15 | Every agent hit the Anthropic session limit ("resets 12:40am"). Run 1 ended with 103 done, 2 partial, 215 agent errors. The monitor wakeups were subject to the same limit and could not restart it. |
| 07:10 | Braden: "GET IT FIRED UP AGAIN". A cache resume began re-running finished items (the workflow cache is call-order sensitive), so it was stopped. Built `rebuild.py`, which merges every journal's finished results into a fresh self-contained script. Run 2 (`wf_5a292638-3cf`) launched on the 98 unfinished items. |
| 07:46 to 10:21 | Run 2 progressed 9, 21, 34, 45, 52, 57 items at the half-hour checks, then the pool starved: the conflict rule treated a file listed as *shared* by two items as exclusive, and 140 of the remaining items share `moodle-browser-catalog.json`, `service-worker.js`, `edit-policy.js`, and `MOODLE-FULL-FUNCTIONALITY.md`. |
| 10:21 to 10:22 | Run 2 stopped. Conflict rule relaxed (shared-with-shared is allowed; owned-with-anything is not), agents told to make small targeted edits to shared files. Run 3 (`wf_fe729573-f2c`) launched. |
| ~10:35 | Session limit again ("resets 12pm"). Run 3 ended with 0 results. |
| 11:02 | Braden switched the Claude Code account (`/login`) and asked for the workflow back. Run 4 (`wf_b293537a-1cf`) launched from a fresh rebuild: 159 done, 42 remaining. |
| 11:23 | Braden asked for the website workflow. Launched `wf_a78c6738-113` (Section 9). |
| 13:23 | Status for Braden: 184 of 201 main items done; website audit done (222 findings), plan written, implementation under way. |
| 13:52 | Braden: get both to a stopping point, write this handoff. Main run had 5 items in flight and 4 queued; website run was on its last implementation item. Both were allowed to drain toward a clean boundary (Section 4.4). |
| 14:21 | Main run's Implement phase finished (every item launched and reported). Its first seven Verify-Opus agents started and were stopped within a minute; no verification result exists. |
| 14:45 | Braden: shut the workflows down now. Website run stopped after its three verifiers had reported and before its fixer and final check ran. Handoff finalized from the journals. |

### 3.1 Why the runs kept restarting

Four restarts, four different causes, all recorded so nobody repeats them:

1. **Widening concurrency (21:19).** Needed a script change; resumed from cache correctly.
2. **Session limit (00:15).** Account quota. Nothing to fix in the workflow; the monitor could not act because it shared the limit.
3. **Cache resume re-ran finished work (07:10).** The Workflow tool's resume cache keys on call order. A rolling scheduler changes call order, so a resume replays only the longest unchanged prefix. Fix: `rebuild.py` embeds finished results in the script and skips them by item ID instead of relying on the cache.
4. **Scheduler starvation (10:21).** Conflict rule too strict for the Moodle lane's shared files. Fix: relaxed rule plus explicit shared-file etiquette in every implementer prompt.
5. **Session limit (10:35) and account switch (11:02).** Account quota again; Braden switched accounts.

### 3.2 Machine facts

MacBook Air (`Bradens-MacBook-Air.local`), 10 cores, Node 26.4.0, pnpm 10.6.1. Free disk fell from 14 GB to 8 GB during the day (screenshots, transcripts, build output) and recovered to 11 to 13 GB as caches cleared. Thirteen Playwright-launched Chrome and headless-shell processes from earlier Codex sessions have been running for 2 to 20 hours; they were left alone. The Codex app and its computer-use helpers are still running from the 5 September session.

### 3.3 Where the evidence lives

Durable (inside the checkout, unstaged):

```
work/handoff-2026-09-07/
  APPENDIX-A-work-items.md      every work item, its evaluation findings, status, agent report, files, tests
  main-journal-merged.json      full agent return values for all 201 items and 7 analyses
  website-journal.json          full return values for the website run (audits, plan, items, verify, fix, final)
  test-failure-lines.json       every test line an implementer reported as failing or timing out
  analysis/{canvas,nq,moodle,blackboard,bridge,desktop,ux}.md   the 7 lane reports (85 to 115 KB each)
  website-audit/{truth,design,language,conversations,structure,value}.md   the 6 website audits
  website-audit/PLAN.md         the 1,725-line website plan with final copy for every section and conversation
  workflow/morrow-1-0-finish-r1-original.js   the first script (analysis + waves of 4)
  workflow/morrow-1-0-finish-r2.js            the rolling-scheduler script with embedded data
  workflow/morrow-1-0-finish-r4.js            the script the final main run used
  workflow/morrow-website-polish.js           the website workflow script
  tools/with-lock.sh, tools/monitor.py, tools/rebuild.py
```

A second copy is at `/Users/example/Projects/.morrow-backups/handoff-2026-09-07/`.

Ephemeral (session scratch, may vanish on reboot):

```
/private/tmp/claude-501/-Users-Braden/8958d3ef-46d5-4bd5-9911-10f24e3f0160/scratchpad/
  analysis/, website-audit/, website-shots/ (about 300 MB of PNG screenshots), locks/, monitor-state.json
/Users/example/.claude/projects/-Users-Braden/8958d3ef-46d5-4bd5-9911-10f24e3f0160/subagents/workflows/<runId>/
  journal.jsonl and one agent-<id>.jsonl transcript per agent (about 400 MB total)
```

---

## 4. The workflow system

### 4.1 Shape

One script, five phases, all agents Opus 5 at `effort: max` except the three Fable 5.1 verifiers:

1. **Analyze.** Seven lane agents. Each read the handoff, the remaining-work ledger, the completion goal, and its lane's code and tests; evaluated the existing work with `file:line` findings; broke all remaining lane work into items with `filesOwned`, `sharedFiles`, `dependsOn`, `completion`, `testCommands`, `localLimits`, `size`, `priority`; and wrote a self-contained lane report.
2. **Implement.** One agent per item. Items scheduled by dependency and priority in a rolling pool (4 concurrent in run 1's first hours, 8 after). Two items never run at the same time if one *owns* a file the other touches. Partial results are retried once with the prior summary. Every implementer was told: real executing tests (not grep tests), mutation checks where cheap, honest partial or blocked over false done, list any edit outside ownership.
3. **Verify-Opus.** One adversarial verifier per lane, told to refute every done claim and to report the known baseline reds as findings; then one fixer per lane for every medium-or-higher finding. **Did not run.**
4. **Verify-Fable.** Three Fable 5.1 verifiers (functional core; desktop and release; experience, truth, privacy, security), then Opus fixers. **Did not run.**
5. **Final-Checks.** Opus re-verification per lane with fixes; one serialized broad-gate agent (build, then each package's vitest one at a time, then `node --test scripts/test/*.test.mjs`, then `pnpm --dir installer test`); a gate-fix agent and a second gate if the first is red; a completeness critic; a ledger agent that updates `MORROW-REMAINING-WORK.md`, the handoff, `LIMITATIONS.md`, and `README.md`. **Did not run.**

### 4.2 Rules every agent received

Verbatim from the script (`RULES`):

- The freeze is staged; every workflow change is unstaged, so `git diff` shows exactly what the workflow changed.
- Never run `git commit`, `push`, `stash`, `reset`, `checkout`, `switch`, `restore`, `clean`, or `add`; never edit `.git` config or hooks.
- Never run `pnpm test`, `pnpm check`, or the whole workspace suite. Run only focused test files, and wrap every build, test, or packaging command in `with-lock.sh`, which serializes heavy commands across all agents on the one MacBook Air. A timeout under contention is not evidence; rerun the single file alone under the lock.
- Build once with `pnpm -r --if-present build` under the lock before vitest in a package that depends on other workspace packages.
- No live LMS access or writes, no deployments, no Docker, no automation of the system Chrome, no CI triggers. ExamplePlatform VPS read-only over SSH, only when the assignment says so (only the `nq` analysis did).
- Edit only owned and named shared files. `website/`, `launch/`, `.agents/` are untracked local directories; only the `ux` lane (and later the website workflow) edits `website/` on disk.
- Plain, exact language. Never claim live proof that does not exist. Keep one explicit dispatch, fresh saved-result readback, uncertain-result-is-not-retryable, exact course scope, and the privacy boundary on every write path.

### 4.3 Runs

| Run ID | Script | Launched | Ended | Outcome |
| --- | --- | --- | --- | --- |
| `wf_b53fdf26-f62` | r1 (analysis + waves), then r1 patched (replay + rolling pool of 8) | 6 Sep 15:08; resumed 21:20 | 7 Sep ~00:15 | 7 analyses; 103 items done, 2 partial; session limit |
| `wf_5a292638-3cf` | r2 (self-contained, seeded with 103 results) | 7 Sep 07:14 | 10:21 (stopped) | +56 done, 1 partial; pool starved on shared files |
| `wf_fe729573-f2c` | r3 (relaxed conflict rule) | 10:22 | ~10:35 | 0 results; session limit |
| `wf_b293537a-1cf` | r4 (rebuilt seed: 159 done) | 11:02 | 7 Sep, stopped at the end of Implement (Section 4.4) | see Section 5 |
| `wf_a78c6738-113` | website polish | 11:23 | 7 Sep (Section 9.4) | see Section 9 |

Concurrency: the Workflow tool caps concurrent agents per run at `min(16, cores − 2)` = 8 on this machine. Two runs shared the box from 11:23; the website run was capped at 4 by its own script.

### 4.4 Why the verification phases never ran, and how the stop was made

Every run was interrupted before the Implement phase finished (limits, starvation, account switch), and Braden asked for a stopping point while run 4 was still implementing its last items. The verification, gate, critic, and ledger stages are therefore untouched. Nothing in them was skipped by decision; they were simply never reached.

The stop itself. The main run was stopped at 14:21, the moment its scheduler had no implementation items left and had launched the first seven Verify-Opus agents; those agents had been reading for under a minute and produced nothing, so no file was left half-edited. The website run finished all ten implementation items and all three verification verdicts, then was stopped at 14:45 on Braden's instruction before its fixer and final-check agents ran; its 54 verifier findings are therefore recorded but unfixed (Section 9.7). Section 5.9 records the exact item state; Appendix A is regenerated from the final journals.

### 4.5 Tools

- `tools/with-lock.sh <command>`: `mkdir`-based mutex at `<scratch>/locks/heavy.lock` with a stale-pid check. Every agent build and test went through it.
- `tools/monitor.py [--all]`: reads a run's `journal.jsonl` and agent transcripts; prints results, live agents with their item label and transcript idle time, session-limit markers, lock holder and age, disk, git counts, remote-branch presence, and an `ACTION` line (`OK`, `LOCK_HUNG`, `RATE_LIMITED`, `STALLED`, `DISK_LOW`, `COMPLETE?`). Paths inside it point at the session scratch directory and the session's workflow directory; edit the constants at the top if reused.
- `tools/rebuild.py`: merges all journals, keeps the best result per item (a `done` beats a later `partial`), embeds items and results in a new `morrow-1-0-finish-rN.js`, and prints the counts. Its `DATA` block is the seed; with all items done, the resulting script skips Implement and starts at Verify-Opus, which is exactly how to run the verification phases later (Section 16).

---

## 5. State of the main work at the stop

Per lane (Appendix A has every item; `main-journal-merged.json` has every full report):

| Lane | Items | Done | Partial | Not started |
| --- | --- | --- | --- | --- |
| Canvas | 25 | 25 | 0 | 0 |
| New Quizzes and Item Banks | 20 | 20 | 0 | 0 |
| Moodle | 51 | 50 | 1 | 0 |
| Blackboard | 27 | 25 | 2 | 0 |
| Bridge, MCP runtime, multi-agent | 28 | 28 | 0 | 0 |
| Desktop, installers, release | 27 | 27 | 0 | 0 |
| UX, docs, website (main run's lane) | 23 | 23 | 0 | 0 |
| **Total** | **201** | **198** | **3** | **0** |

Final state from the journals at the stop; Section 5.9 names the three partial items and Appendix A has every row.

### 5.1 Canvas (25 of 25 done)

What the analysis found (16 findings, 2 critical): 65 admitted writes planned their readback against a *different* resource than the one written, so a destructive `canvas_reset_course` could report "verified" because the replacement course could be fetched; the generic readback evaluator accepted a matching value found anywhere in a response subtree; six self-scoped writes (bookmarks, nicknames) were advertised but refused by every enforcement layer; an `applied_or_unknown` Canvas write could never be resolved and permanently locked its target; the audit tool reported the Classic Quiz description repair as blocked although the path existed; no program accessibility ledger existed; PDF, oversized, and permission-denied files failed as opaque errors; the settings Edit surface derived 223 flat categories, 47 destructive, with blanket field grants.

What was built (highlights; every item in Appendix A.canvas):

- Readback planner refuses any read route that is not the write target's own resource (canvas-01); evaluator proves the postcondition on exactly one target record (canvas-02); 66 writes reclassified and documented in `CANVAS-READBACK-BLOCKERS-2026-09-06.md`.
- Self-scoped writes held at admission with reason `self_scope_not_supported` (canvas-03).
- Generated admission report `artifacts/canvas-api/canvas-admission-report.json` with `pnpm canvas:admission:check`, and the two documents bound to it by a drift test (canvas-04); `docs/implementation/CANVAS-ADMISSION-CLASSES.md` names every hold class.
- Semantic course-target resolver for object-addressed routes, proved end to end on Sections, then Groups, Files, Calendar (canvas-05 to canvas-08).
- Read-only `morrow_program_ledger` tool and the `morrow://guidance/program-audit-ledger-v1` resource (canvas-11); honest structured audit outcomes for unreadable, oversized, binary targets (canvas-12); syllabus, announcements, rubrics added to inventory and audit (canvas-14); render checks; PDF and Office byte signals; typed Classic Quiz answers and guarded question repair (canvas-15 to canvas-18); stale Classic Quiz description status corrected (canvas-17).
- Unresolved Canvas writes can be settled by a retained read-only comparator and the lock releases only on verified settlement (canvas-20); duplicate-create detection.
- Edit categories derived from the admission contract with a destructive tier and no blanket grants (canvas-21); `docs/implementation/EDIT-CATEGORY-CONTRACT.md`.
- Narrowed `webRequest` filter; multi-step file pre-flight routes held; bounded list resume; privacy-safe instructor aggregates (canvas-22 to canvas-25).

Live limits: no live Canvas write was made this session. Every result is fixture and unit proof.

### 5.2 New Quizzes and Item Banks (20 of 20 done)

See Section 6.

### 5.3 Moodle (50 done, 1 partial)

What the analysis found (14 findings): 16 of 23 core modules were settings-only and 7 had no route; 12 of 17 question types read-only; every Question Bank write held; gradebook rename-only; groups read-only; a confirmed pagination defect that hard-failed any Forum with a full page plus one restricted post; the Forum activity summary unintegrated; hardcoded capability metadata that marked the one destructive Moodle operation non-destructive.

What was built: the catalog grew from 103 operations at the freeze to 246 entries at the stop (agents report 242 operations plus metadata rows; see Section 8 for the count drift). Each module family got its own executor file under `connector/extension/src/moodle-*.js` with a browser fixture test under `scripts/test/`, so items could run concurrently. Families covered by done items: Forum (activity summary integrated end to end, discussion writes), Choice, Book and chapters, Lesson, Glossary, Wiki, Feedback, Database, Folder, IMS, SCORM (settings edit, package replacement, attempt and learner reads that a stock site refuses), Text and media, URL, sections and subsections, course settings and summary, whole-course show and hide, gradebook configuration reads and renames, grader-report summary and roster-projected learner report, groups map, Assignment settings scope and overrides, Quiz settings scope and overrides, Question Bank filter inventory and impact scope, the hidden `mod_qbank` activity route (phase one), participants, enrolments, activity and section restrictions, completion. Approval expiry is enforced in the readers (moodle-03); the gradebook readback mismatch sets its own uncertain state (moodle-07); the doc-consistency test `scripts/test/moodle-doc-consistency.test.mjs` fails on drift between the catalog and the three documents.

Partial: `moodle-38` (section-level access restrictions can be preserved and refused, not written). Section 5.9 has the agent's statement.

Live limits: 31 operations have signed-in Moodle 5.2 sandbox proof from before the freeze; nothing new was proven live. `docs/implementation/MOODLE-LIVE-PROOF-CHECKLIST.md` and `scripts/moodle-live-proof.mjs` were added for the day a person runs it.

### 5.4 Blackboard (25 done, 2 partial)

What the analysis found (18 findings, 2 critical): configuring a Blackboard tenant stopped the whole MCP server from starting (a `process.cwd()`-relative resolution of the package); every Blackboard failure was journalled as `applied_or_unknown`, including refusals that sent nothing.

What was built: both criticals fixed (blackboard-01, blackboard-02). The server credential's acting principal is verified through `GET /learn/api/public/v1/users/me` instead of trusted from config (blackboard-03); content writes admit only what the recovery contract allows and freeze a fixed protected field set (blackboard-04); the approval page names course and item and shows saved beside requested values (blackboard-05). New operation families under `packages/blackboard-learn-api/src/operations/`: contents, files metadata, announcements, groups and group sets, gradebook columns, attempts, and one person's grade, memberships and roster summary, course lifecycle, availability and dates, each with mocked-HTTPS tests and each read redacting learners to protected references. `docs/implementation/BLACKBOARD-REST-SCOPE.md` is the route inventory, held operations, and live-tenant acceptance runbook. `scripts/blackboard-catalog.mjs` generates `artifacts/blackboard/blackboard-rest-catalog.json`. The public MCP exposes the reads and one change operation, `morrow_plan_blackboard_content_patch`; apply and verify remain private gateway-only tools.

Partial: `blackboard-20` (a Blackboard *browser* catalog, which the agent refused to build because it reverses a recorded decision that Blackboard ships through the REST route only; needs Braden's word before anyone tries it again) and `blackboard-21` (consumer setup still shows a typed principal-id field instead of live account verification and real course names). Section 5.9 has both statements.

Live limits: no tenant. Every Blackboard statement is mocked-HTTPS proof only, and the docs say so.

### 5.5 Bridge, MCP runtime, multi-agent workflows (28 of 28 done)

What the analysis found (26 findings, 2 critical): six test-helper sites computed a stale two-part bridge catalog digest after `canvas-browser-catalog.json` joined the digest, so the bridge refused the hello with close 4403 and three integration suites blocked forever; any non-ok HTTP status on a Canvas write returned no `outcomeUnknown`, so one harmless 422 permanently conflict-locked a Page with no reconcile path.

What was built: stale digest removed from every helper site, so `canvas-connector`, `local-owner`, and `program-scale` integration suites reach real assertions (bridge-01); refused handshakes fail fast with the close code (bridge-02); the connector exits and releases the Bridge port when its assistant is gone (bridge-03); Canvas write failures classified by HTTP status class end to end (bridge-06); unresolved locks have exactly two exits (bridge-07); Settings actions say whether Morrow can check the saved result and mark content removal (bridge-08); batch windows bounded, cancellable, attributed (bridge-09); batch progress reporting (`batch-progress.test.ts` added to `test:batches`); multi-client ownership, conflict refusal, cancellation, restart, and partial-result behaviors (bridge-10 to bridge-18); popup and settings copy without decorative labels (bridge-19); Edit grant expiry surfaced (bridge-21); loopback hardening (bridge-25, bridge-26 in Appendix A).

### 5.6 Desktop, installers, release (27 of 27 done)

What the analysis found (22 findings, 5 critical): `bridgeInstalled` hard-coded to `"unknown"` so the renderer could never advance; guided first-run dead-ended at "Add Morrow Bridge" with the connect and first-read buttons unreachable; `shell.openExternal("chrome://extensions/")` cannot work on macOS or Windows; `installer/` was not a workspace package so zero installer tests ran in any gate; three stale root entry files.

What was built: `installer/main.cjs` split into testable modules with executed tests replacing source-regex tests (desktop-01); Bridge state split into three facts and the first-run panel unblocked (desktop-02); the broken "Open Chrome extensions" action replaced by "Show Bridge folder" plus numbered, command-free Chrome instructions (desktop-03); installer suites inside the authoritative gate, 114 tests (desktop-04); root duplicates deleted with a guard (desktop-05); the MCP runtime readback reads the version and digest from the sealed payload instead of echoing the parent (desktop-06); update engine harness against the real `electron-updater` with a local feed (`scripts/test/desktop-update-harness.test.mjs`, in `test:desktop:update`); Windows DACL and gateway-health smoke path (`scripts/test/desktop-windows-smoke.mjs`, refuses to run off Windows); macOS smoke (`scripts/test/desktop-mac-smoke.mjs`); `release-signing-preflight.mjs`; `.github/workflows/desktop-release.yml` with `macos-14` and `windows-2022` jobs on manual dispatch; `FIRST-RUN-STATE-INVENTORY.md`; ports from the two sibling worktrees `windows-desktop-qa-20260906112513` and `windows-chatgpt-inventory-20260906` where the analysis judged them correct.

Live limits: unsigned builds only; no DMG mounted, no Gatekeeper evaluation, no NSIS run on Windows, no signed update; Apple silicon and Windows x64 only. All stated in `LIMITATIONS.md`.

### 5.7 UX, docs (23 of 23 done in the main run)

The main run's `ux` lane fixed the popup dead state on a failed first status read (ux-09), the installer "Checking Morrow setup…" forever state and the progress-rail order (ux-14, ux-15), rewrote `README.md` and `LIMITATIONS.md` to evidence with banned-phrase tests (ux-18, ux-20), removed the retired Blackboard browser wording from three surfaces (ux-20), reconciled `.better-web-ui.md` with the brand doc (ux-22), added executing website checks (ux-01 to ux-06), and introduced `scripts/test/product-claims.test.mjs` (ux-19). The later website workflow (Section 9) rebuilt the site on top of that.

### 5.8 Edits outside ownership and cross-lane friction

Agents were required to report any edit outside their file ownership. The reports are in each item's `outOfOwnershipEdits` field in `main-journal-merged.json` and in Appendix A. The recurring pattern: the Moodle doc-consistency test and the Canvas browser-catalog test are red whenever one lane adds catalog operations before another lane documents them, so late Moodle items report those two tests red "for other lanes' tools". That is the drift Section 8 describes; it is a documentation reconciliation, not a product defect.

### 5.9 Final boundary state

Final journal state at 14:45 on 7 September, after the main run was stopped at the end of its Implement phase (no Verify-Opus agent ran):

| Lane | Items | Done | Partial | Blocked | Not started |
|---|---|---|---|---|---|
| canvas | 25 | 25 | 0 | 0 | 0 |
| nq | 20 | 20 | 0 | 0 | 0 |
| moodle | 51 | 50 | 1 | 0 | 0 |
| blackboard | 27 | 25 | 2 | 0 | 0 |
| bridge | 28 | 28 | 0 | 0 | 0 |
| desktop | 27 | 27 | 0 | 0 | 0 |
| ux | 23 | 23 | 0 | 0 | 0 |
| **Total** | **201** | **198** | **3** | **0** | **0** |

Items that are not `done`, with the agent's own statement of what remains:

- `blackboard-20` (blackboard, partial): NOT DONE BY DESIGN, needs Braden to reverse a recorded decision before anyone attempts it again: item steps 1-4 (generate connector/extension/generated/blackboard-browser-catalog.json; accept "blackboard" in packages/canvas-connector-mcp/src/browser-catalog.ts …
- `blackboard-21` (blackboard, partial): Part 2 (live account verification replacing the typed principal id) and the discovery half of part 3 (show real course names) of the item description. Both are still not delivered. The typed-ID field remains, which is the item's own stated fallback, with an ex …
- `moodle-38` (moodle, partial): Writing section-level access restrictions (creating, changing or removing a section's availability conditions) is not delivered. moodle_update_section now provably preserves them and refuses rather than losing them, but it cannot set them.  If this item is re- …

---

## 6. New Quizzes and Item Banks (Braden's correction)

The `nq` analysis read, read-only over `ssh example-lms-vps`, at checkout `/opt/example-attestation-repo` `06e0eb5d4495413664479c229897aceea3437a91`:

- `scripts/team/mcp/tools/newquizzes.py`
- `example-kit_automation/nq_client.py`
- `example-kit_automation/nq_item_bank_sdk.py`
- `example-kit_automation/item_bank_governance.py`
- `docs/canvas/item-banks-sdk.md`

and wrote `docs/research/CANVAS-NEW-QUIZZES-ITEM-BANKS-CONTRACT-2026-09-06.md`: the three surfaces (`/api/quiz/v1/`, `/api/banks/` inside the course-bound Item Banks LTI frame, and the Canvas REST assignment surface), request and response shapes per interaction type, identifier preservation, failure semantics, role permissions, and the limits of the harvest. No credentials, hostnames, or student data are in the file.

The 8 September complete-contract audit and builder-credential follow-up supersede the original guarded-write conclusion.

Current state:

- Seven private reads are implemented: six bank-management reads and one complete quiz-entry/bank-draw read.
- All nine owner-write shapes are held before provider I/O. Bank creation lacks a recoverable course-association transaction, existing-bank changes lack complete downstream reach, and the bank draw lacks durable interruption recovery.
- Bank management uses the selected course's exact Item Banks launch. A quiz bank draw also uses the exact selected assignment's builder launch and verified private quiz id.
- `morrow_read_item_bank_fan_out` records entry counts, observed share rows, and selected-course quiz uses. It cannot map current private share context UUIDs to numeric Canvas course ids from proved data. It always reports `complete: false` and never grants authority.
- `morrow_plan_item_bank_question_image_alt_repair` depends on the held complete-item update and stops before a bank read or PATCH.
- `docs/implementation/ITEM-BANK-LIVE-PROOF-PLAN.md` covers all 16 operations. Under the current audit assignment it authorizes no provider write.
- All private bank and builder routes remain live-unverified in Morrow.

Stimulus repair is not claimed. The harvest does not establish a complete preservation contract for every Stimulus field.

---

## 7. Verification status

### 7.1 What is proven

Per item: the implementing agent ran the focused test files it listed (Appendix A, "Tests run" column; full text in the JSON). Most items also ran a mutation or negative check: revert the fix or corrupt the input, show the new test goes red, restore, show green. Those checks are recorded in the same field. Examples: desktop-14 (23 pass / 8 fail with behaviors removed, 31 / 0 restored), moodle-03 (expired approval accepted before the change, refused after), nq-02 (loosened frame pattern caught by 3 failures), blackboard-18 (null-date fix reverted fails exactly the new test).

Not proven: anything by an independent reader. No verification-phase agent ran. No whole-suite run has completed since the freeze.

### 7.2 Known reds (the broad gate will fail on these until they are handled)

From `test-failure-lines.json` (54 lines, most of them agents documenting a red they proved was not theirs) and the last complete gate attempt before the freeze (6 September 14:48, killed during `packages/mcp-server`):

1. **`packages/mcp-server/test/batch.integration.test.ts` › "removes an audit target whose exact identifier would change during learner redaction"** (line ~1422 to 1503). Fails reproducibly: expected `audit_children: []`, got one syllabus child. Reported red by eleven different items; canvas-13 wrote a root-cause note in its blockers field. This is a real Canvas defect, most likely introduced when canvas-14 added the syllabus target to inventory: a syllabus child has no learner identifier to redact and therefore is not removed. **Owner: canvas lane. Fix the eligibility rule or the fixture, then rerun the file alone under the lock.**
2. **`packages/mcp-server/test/moodle-resource-file.integration.test.ts`** times out at 30 s. bridge-01 called it "the seventh stale site the lane report missed" (a bridge catalog digest helper it did not own). Check whether the digest fix was applied there; if not, apply bridge-01's pattern.
3. **`packages/mcp-server/test/program-scale.integration.test.ts`** times out at 90 s on this machine (canvas-11, canvas-12). bridge-01 fixed its digest site; the remaining timeout may be machine capacity (forty audits through three clients). Run alone under the lock on an idle machine before deciding.
4. **`scripts/test/moodle-doc-consistency.test.mjs`**: 2 to 3 of 5 fail because the Moodle catalog (246 entries) is ahead of `README.md`, `LIMITATIONS.md`, and `THREE-LMS-BRIDGE-PARITY.md` counts and evidence groups (Section 8). Documentation reconciliation.
5. **`packages/canvas-connector-mcp/test/browser-catalog.test.ts:100`**: expects `dataClass: "learner"` for `canvas_read_course_file_signals`; the catalog now says `"course"`. One of the two is wrong; moodle-31, moodle-34, moodle-48 saw it. Decide which class is right and fix the other side.
6. **`packages/gateway-core` publication and source-rights tests**: "public assembly input digest drift" because `config/source-rights.manifest.json` pins digests of files the workflows edited (canvas-02 hit it on `LIMITATIONS.md`). Regenerate with `pnpm source-rights:generate` and `pnpm source-origin:generate`, then rerun `pnpm test:package`.
7. **`scripts/test/product-claims.test.mjs`**: nq-20 saw 3 failures from the same Moodle count mismatch as item 4.
8. The 6 September gate also showed `canvas-connector.integration.test.ts` and `local-owner.integration.test.ts` timing out; bridge-01 and bridge-02 report both now pass after the digest fix (6 of 6 and 12 tests respectively). Re-confirm in the serialized gate.

Everything else the implementers reported red was either a deliberate negative control or explicitly attributed to one of the eight lines above.

### 7.3 How to run the gate without lying to yourself

The machine gives false timeouts when suites run in parallel with other heavy work. Run it serialized and alone:

```sh
cd /Users/example/Projects/.morrow-worktrees/example-worktree
pnpm -r --if-present build
for p in contracts bridge-protocol canvas-api-catalog gateway-core client-config operation-journal upstream-mcp \
         blackboard-learn-api batch-engine bridge-loopback canvas-connector-mcp legacy-bridge-mcp mcp-server; do
  [ -f "packages/$p/package.json" ] && grep -q '"test"' "packages/$p/package.json" && \
    (cd "packages/$p" && pnpm exec vitest run --fileParallelism=false) || true
done
node --test scripts/test/*.test.mjs
pnpm test:desktop
```

`pnpm check` is the authoritative one-shot gate (`pnpm test`, which now includes `test:desktop`) and takes 15 to 25 minutes on this machine when nothing else runs. The extension's own gate lives in the main checkout, not here.

---

## 8. Documentation state

- **`README.md` and `LIMITATIONS.md` were rewritten to evidence** by ux-18 and ux-20 and then edited by many Moodle and Blackboard items as they added operations. At the stop, `README.md` line 5 and `LIMITATIONS.md` line 27 both say 242 Moodle operations with 31 checked, but `moodle-doc-consistency.test.mjs` still fails on evidence groups and on 8 to 9 tool names that later items added without documenting. The website planner recorded the earlier disagreement (167/31/136 versus 174/31/143) as escalation D1 and deliberately printed **no Moodle total on the site** so it cannot go stale.
- **`LIMITATIONS.md` line 7 carries the "canonical platform sentence"** that every surface must quote exactly; it was written by ux-20. The website quotes it on exactly three pages with plain lead-ins (Section 9.3).
- **`docs/implementation/MORROW-REMAINING-WORK.md`** has not been updated since 6 September 18:15 UTC. The workflow's ledger stage that would have rewritten it did not run. It is now materially stale on Canvas, Moodle, Blackboard, and desktop.
- **`docs/implementation/MORROW-1.0-HANDOFF-2026-09-06.md`** was edited this session to record the repository-scope decision; otherwise it describes the freeze.
- **`SOURCE-ORIGIN.md`, `config/source-origin-ledger.json`, `config/source-rights.manifest.json`**: stale (Section 2.3, Section 7.2 item 6).
- **`WEEKEND-HANDOFF.md`** (root) was modified by an agent; re-read before relying on it.
- **New documents** (Section 2.4) are current as of their items.
- **`docs/implementation/THREE-LMS-BRIDGE-PARITY.md`** was reconciled by moodle-08 to the then-current catalog and is out of date again.

A single reconciliation pass (one agent or one person, an hour) closes items 4, 6, and 7 of Section 7.2 and refreshes the remaining-work ledger.

---

## 9. The website

### 9.1 Scope and rules

Run `wf_a78c6738-113`, script `work/handoff-2026-09-07/workflow/morrow-website-polish.js`. Owned only `website/` and `scripts/test/website-content.test.mjs` (plus new `scripts/test/website-*.test.mjs`). Authorities, in order: `LIMITATIONS.md` and `README.md` for facts; `.agents/product-marketing.md` for purpose and banned phrases; `docs/brand/MORROW-BRAND.md` for visuals and voice; plain language for an instructor. Screenshots at 320, 390, 768, 1024, and 1440 through a local static server and headless Chromium; never the system Chrome. No deployment, no git.

### 9.2 Audit (six Opus 5 lenses, all 17 pages plus the share card)

| Lens | Findings | Report |
| --- | --- | --- |
| Truth and currency | 33 | `website-audit/truth.md` |
| Design consistency and layout | 37 | `website-audit/design.md` |
| Language and clarity | 51 | `website-audit/language.md` |
| Sample conversations (132 turns judged) | 36 | `website-audit/conversations.md` |
| Structure, navigation, accessibility | 43 | `website-audit/structure.md` |
| Value communication | 22 | `website-audit/value.md` |

Headline truth findings: Moodle described as partial or absent where it is the second-best-covered platform; Blackboard described through a browser route that does not exist; the download page said "Installer in progress" with no build facts; the install steps predated the desktop app's "Show Bridge folder" flow; a "Send a Canvas Inbox message" claim with no authority behind it; a "Star on GitHub" link that returns 404 on the live site.

### 9.3 Plan (`website-audit/PLAN.md`, 1,725 lines)

Thirteen conflict decisions (D1 to D13) settle the lenses. The ones Braden should know:

- **D1**: the site prints no Moodle operation total (authorities disagreed while the main run was editing them).
- **D2**: the Canvas Inbox *send* claim comes off the site; drafts only, until `README.md` documents the route.
- **D3**: the homepage headline keeps the pinned "Connect your AI assistant to Canvas and Moodle." from the positioning brief; the three-platform statement sits directly below; the exact canonical sentence is quoted on `/features`, `/download`, and `/how-it-works` and nowhere else.
- **D4**: `/build` is repurposed as the open-source page (its route and footer links survive).
- **D5**: the header's filled action is "Get set up" → `/how-it-works`; `/download` moves into the Product menu.
- **D6**: the GitHub octocat leaves the header (dead link on a live site); replaced by a text link "Free and open source" → `/build`.
- **D7**: the repeated footer tagline is deleted on all 18 files.
- **D8**: every assistant turn is `Your Assistant using Morrow`, in Braden's casing; `text-transform: uppercase` removed from the speaker label.
- **D9**: role pages keep two conversations each, all rewritten so no two tell the same story.
- **D10 to D13**: "Your first request" restyled as a copyable starter block; no new external links; `/for-qa-teams` state headings in plain words with a test map; at most one `.work-examples` block per page.

Section 3 of the plan is the shared copy contract: the plain platform statement, the three plain platform paragraphs (Canvas, Moodle, Blackboard, each stating its real proof level), the six install and first-run steps as the desktop app actually presents them (Show Bridge folder, Developer mode, Load unpacked, Connect Morrow, Connect course site, one first read), the download truth (`1.0.0-rc.0`; unsigned Apple silicon build; unsigned Windows x64 installer; no Intel, no Linux; nothing published), the four assistants (ChatGPT, Claude Desktop, Claude Code, Gemini CLI), the label, the voice rules. Section 6 is the final text of all 22 conversations. Section 6.9 lists conversations that must never be written (anything implying a live Blackboard result, Moodle question authoring, a phone-proven flow, or a Canvas message send).

### 9.4 Implementation and verification

Ten items: `site-00` (styles, roles, script, shared header and footer) first, then nine page items in a pool of 4, then `site-09` (pin the new copy in the test). Each page agent screenshotted its pages at five widths and looked at them before reporting. Then three adversarial verifiers (truth; visual and structure; language, conversations, value), one fixer, one final check.

Result at the stop: all ten items done; the three verifiers reported 11, 24, and 19 findings (54 total: 2 critical, 9 high, 27 medium, 16 low); the fixer and the final check never ran because the run was stopped at 14:45. The findings are listed in Section 9.7 and in full in `website-journal.json`. The two criticals: the `/for-instructional-designers` hero contradicts its own h1 and meta description; and the flagship homepage conversation shows Morrow applying an item-bank change that affects three other courses, which violates the exact-scope guarantee it exists to demonstrate. The three high visual findings are all in `styles.css`: empty paired rules on ten pages, the navigation hidden behind a hamburger at 1024 px, and full-width buttons below 980 px.

### 9.5 Escalated to Braden by the planner (not fixed by agents)

1. `README.md:5` and `LIMITATIONS.md:27–28` disagreed on Moodle counts (now both 242; the consistency test still fails on evidence groups). The site prints no total until the docs are reconciled.
2. `packages/mcp-server/src/` carries a reviewed Canvas Inbox send (`canvas_send_private_conversation`) that neither `README.md` nor `LIMITATIONS.md` documents. If it is real and proven, documenting it is the single biggest upgrade available to the student-support conversations on the site.
3. `website/social-card.png` is a committed render; editing `social-card.html` changes nothing until the PNG is re-rendered, and all 18 pages point `og:image` at it. (The `site-08` agent reports it re-rendered the card; confirm the PNG timestamp.)
4. **The live site at `meetmorrow.app` says "free and open source" and links to `github.com/example-owner/morrow`, which returns 404 unauthenticated.** Either publish the repository, make it public, or take the claim down. The rewritten site keeps the open-source statement (it is in the positioning brief) but removes the dead header link.

### 9.6 Deployment

Not done and not attempted. The previous deployment record is in the remaining-work ledger: Cloudflare deployment `ad68fdac-d404-4938-a1d8-845de52a3868`, hash-checked against `output/cloudflare-website-final-20260906-freeze/`. The `output/` directory is gitignored and still holds those staging copies. Deploy the rewritten `website/` the same way after reading Section 9.7 and looking at the final screenshots in the session scratch directory (`website-shots/final/`) or by serving `website/` locally:

```sh
python3 -m http.server 8700 --bind 127.0.0.1 --directory website
```

### 9.7 Website run result

Website run journal at 14:45 on 7 September: 11 implementation results, 3 verification verdicts, 0 fix reports, 0 final checks.

- **Verifier: TRUTH, every factual claim on all 18 pages re-checked again …**: 11 findings ({'high': 2, 'medium': 4, 'low': 5}). Verdict: `node --test scripts/test/website-content.test.mjs` → 44 tests, 43 pass, 1 skip, 0 fail (re-run twice, both green). CONVERSATION LABELS: PASS: all 57 assistant turns (index 15, five role pages 6 each, /remote 6, /for-teams 3, /features 3) carry exactly `Your Assistant using Morrow`; a parse of every `.conversation-response` / `.role-message-response` element found zero deviations, and no `>Morrow<` speaker label survives anywhere. BANNED PHRASES: PASS: none of `Development preview`, `course te …
  - high `/features (features.html)`:16: The Canvas paragraph attaches live test-course proof to a capability list far wider than the evidence: "the only one where changes have been made and checked on a live test course: pages, modules, assignments, discussion …
  - high `/ (index.html)`:66: The LMS-administrator conversation says "most of its Moodle work has only been checked on a test site." That is the opposite of the record and makes the unproven majority sound more proven than it is. README.md:5 and LIM …
  - medium `/ (index.html)`:42: The homepage conversation drafts "118 repairs" from 168 findings made up of 96 images with no description, 49 headings that skip a level, and 23 tables with no header row (line 40). 118 exceeds the 96 image findings, so …
  - medium `/ (index.html)`:113: "Morrow opens the item in the browser you are already signed in to, so what your assistant reads is what your students see." LIMITATIONS.md:34 forbids exactly this reading: the saved-source render "is not the learner's C …
  - medium `/features (features.html)`:17: "Whichever platform you use, Morrow adds none. It opens what your signed-in account can already open." This is false for Blackboard. LIMITATIONS.md:30 and README.md:290 state that Blackboard acts as a Learn integration a …
  - medium `/build (build.html)`:20: "Every change waits for you. Morrow saves nothing until you approve it on a page it runs on your own computer." Naming the review page makes the claim absolute and false once Edit access is granted. README.md step 7 says …
  - low `/ (index.html)`:24: The hero proof bullet states without qualification: "Nothing is saved until you approve it, and Morrow reads the item back to show you what the course kept." LIMITATIONS.md:56 says a write with no safe frozen readback ro …
  - low `/for-lms-admins (for-lms-admins.html)`:26: The section FAQ lists three actions, "It can rename a section, change its dates, or remove it", then closes with "Neither of these two changes has been tried on a real school's Canvas yet." Three actions cannot be "the …
  - low `/privacy (privacy.html)`:13: "The record that matches those labels to real students is encrypted": repeated on /for-instructors line 21 as "the record that maps labels to your students stays encrypted on your computer." README.md:311 names "the lea …
  - low `/support (support.html)`:20: "Five things stop Morrow more often than anything else." This is a claim about observed failure frequency. Nothing has been published (LIMITATIONS.md:87), there is no release and no user base, and no authority records fa …
  - low `/download (download.html)`:4: The page hero says "The Mac and Windows installers are being built now" (and /index line 102 says "The Mac and Windows installers are still being built"), which reads as work in progress with no artifact. Its own status …
- **Verifier: LANGUAGE, CONVERSATIONS, AND VALUE, adversarial read of all …**: 24 findings ({'critical': 2, 'high': 4, 'medium': 12, 'low': 6}). Verdict: TEST: `node --test scripts/test/website-content.test.mjs` = 44 tests, 43 pass, 0 fail, 1 skip. Green.  The rewrite genuinely lands the big things: all 57 assistant turns now read "Your Assistant using Morrow"; no banned phrase from the positioning brief survives anywhere; "MCP", "runtime", "dispatch", "readback", "digest", "admission" appear nowhere; "catalog"/"tenant"/"REST API" appear only inside the canonical sentence LIMITATIONS.md:7 pins verbatim; "LMS" appears only as a role name; the six …
  - critical `for-instructional-designers.html`:20: The hero paragraph contradicts its own h1 and the page's meta description. The h1 on line 20 reads "Build the course, then fix the fourteen that came before it." and the meta description on line 6 reads "repair the probl …
  - critical `index.html`:42: The flagship hero conversation violates the exact-scope guarantee it exists to demonstrate. Turn 4 (line 42) says "118 repairs are on Morrow's review page... Four sit in an item bank three other courses share, so Morrow …
  - high `features.html`:9: The "Review course quality and accessibility." chapter opens with one 112-word sentence listing 18 checks with no list markup: 13 unbroken lines at 1440px (see features-quality-w1440.png). It also carries six developer …
  - high `index.html`:56: The homepage "Weekly student support" conversation (lines 55-60) is a near-verbatim copy of the /for-instructors conversation (line 21). Two sentences are word-for-word identical on both pages: "They are addressed by la …
  - high `index.html`:64: The homepage "Across every section" conversation (lines 63-68) is a near-verbatim copy of the /for-lms-admins "Fix term setup" conversation (line 25). One sentence is identical: "Morrow keeps the record, so you can ask …
  - high `index.html`:66: The Moodle turn overstates the evidence and ends in an unexplained idiom: "Morrow reads Moodle through the same signed-in Chrome tab, but most of its Moodle work has only been checked on a test site, so treat anything it …
  - medium `for-qa-teams.html`:21: The same accessibility-review conversation shape is told three times across the site with only the digits changed: index.html:40 ("168 need attention: 96 images with no description, 49 headings that skip a level, 23 tabl …
  - medium `for-instructors.html`:20: Every role hero paragraph still opens with an audience eyebrow, which docs/brand/MORROW-BRAND.md:11 bans outright ("Do not add audience eyebrows"). It has only been folded into the first words of the body paragraph: "For …
  - medium `index.html`:47: British and American spellings of the same word appear inside single pages. "practise"/"practised" against "practice"/"practiced": index.html:47 and :71 vs index.html:81; features.html:15 vs features.html:6 and :10; for- …
  - medium `index.html`:40: The one caveat about media Morrow cannot read has four different wordings across five places, so it never becomes a phrase a reader recognises: "Videos and PDFs are not in that count: a person has to open those." (index …
  - medium `for-qa-teams.html`:21: There are three phrasings for the single most important thing Morrow reads: "the saved text" (for-qa-teams.html:21 twice, and :27), "the text Canvas saved" (index.html:40, for-instructional-designers.html:23 and :25), an …
  - medium `for-qa-teams.html`:24: The sentence "Nothing is quietly counted as passed." appears twice on this page: it ends the hero paragraph on line 20 and it is the h2 of the review-states section on line 24. Same words, same page, roughly one screen a …
- **Verifier: Visual and structure, all 17 pages screenshotted at 320/390 …**: 19 findings ({'high': 3, 'medium': 11, 'low': 5}). Verdict: `node --test scripts/test/website-content.test.mjs` → 44 tests, 43 pass, 1 skip, 0 fail. The site is structurally sound and the plan's hardest fixes landed: no horizontal overflow on any of 17 pages at any of the 5 widths; exactly one h1 per page and zero heading-level jumps; every text/background pair clears 4.5:1 (3:1 large) in both light and dark; a visible 2px focus ring on every focusable including the navy band; the tablist has correct roving tabindex plus Arrow/Home/End; the phone menu mo …
  - high `index.html, features.html, remote.html, build.html, for-teams.html, for-instructors.html, for-instructional-designers.html, for-lms-admins.html, for-curriculum-developers.html, for-qa-teams.html (website/styles.css)`:235: A pair of full-width horizontal rules with 80-81px of empty space and no content between them appears 12 times at 1440, 17 times at 390 and 18 times at 768, on 10 of the 17 pages. Verified by eye on index.html at y4243/y …
  - high `website/styles.css (affects all 17 pages at 1024)`:410: At 1024 (one of the five required widths), the whole navigation and the site's only filled CTA ("Get set up") are hidden behind a hamburger, leaving roughly 640px of empty white header between the wordmark and "Free and …
  - high `index.html, features.html, download.html, support.html, all 5 role pages (website/styles.css)`:447: `.button { width: 100% }` applies below 980px, so at 600, 768 and 920 every call to action becomes a 568x48, 736x48 or 888x48 bar with its label pinned to the far left and its arrow pinned to the far right, up to ~800px …
  - medium `index.html, features.html, remote.html, for-teams.html, for-instructors.html, for-curriculum-developers.html, for-qa-teams.html (website/styles.css)`:202: Nine two-column heading blocks leave 121-302px of empty left column below the h2, because `.section-heading` is a grid whose left cell holds only the h2 while the right cell holds a much taller paragraph. Measured at 144 …
  - medium `features.html, remote.html, for-teams.html, for-instructors.html, for-instructional-designers.html, for-lms-admins.html, for-curriculum-developers.html, for-qa-teams.html (website/roles.css)`:32: The `.role-conversation-intro` column empties out 374-548px below its last line beside every conversation, on eight pages, 13 instances total. Measured at 1440: for-qa-teams 548px and 453px, for-instructors 542px and 431 …
  - medium `features.html (website/styles.css)`:286: On six of the eight feature chapters the right column empties out 201-496px below its short bold note while the left column runs on: measured at 1440, y4530 460px, y3865 331px, y2828 308px, y2025 372px, y3405 223px, y709 …
  - medium `index.html, build.html (website/styles.css)`:223: Three single-purpose blocks reserve height they do not use, on the two pages where it is most visible. The navy capabilities band `.capabilities-layout` left cell is 693px tall with 313px empty below `.capabilities-note` …
  - medium `features.html, download.html, support.html, for-instructors.html, for-qa-teams.html (website/styles.css)`:282: The single-column `.page-hero` and `.role-hero` leave a large empty right gutter that no other band on the page has, because the h1 is capped at 1100px (styles.css:283) and the paragraph at 62ch while the shell runs to 1 …
  - medium `how-it-works.html (website/styles.css)`:292: `.how-steps .workflow-list { max-width: 900px }` caps the six setup steps at x130..1030 while the page's own "Six steps, done once." heading, "Who does what.", the FAQ and the footer all span x130..1310. The result is a …
  - medium `download.html (website/styles.css)`:278: download.html renders four h2 elements at 23px ("Where the builds stand.", "Adding Morrow Bridge to Chrome.", "Which platform do you use?", "Blackboard works differently.") and two at 40px ("What you will need.", "Get he …
  - medium `privacy.html, terms.html, security.html (website/styles.css)`:342: On the three policy pages all content and every section rule stop at x990 while the header, footer and the 1310 shell run 320px further right: a permanent empty right gutter that no other page has. Measured at 1440: con …
  - medium `for-instructors.html, for-instructional-designers.html, for-lms-admins.html, for-curriculum-developers.html, for-qa-teams.html, for-teams.html, remote.html, features.html (website/styles.css)`:47: In dark mode the conversation loses the speaker distinction that carries it in light mode. The request bubble paints `--raised` #1a2641 and the response bubble paints `--band` #27354f: 1.22:1 between them, against a ligh …
- No fix report and no final check exist: the run was stopped at 14:45 after the third verifier reported and before the fixer started. Every finding above is open.
- `node --test scripts/test/website-content.test.mjs` run by the handoff script at 14:45: tests 44, pass 43, fail 0, skipped 1.
- Label count on disk: `Your Assistant using Morrow` occurs 57 times across the HTML pages (the truth verifier counted 57 assistant turns); the old bare `Morrow` speaker label occurs 0 times.

---

## 10. Desktop app and installers: what a person still has to do

All from `LIMITATIONS.md` as rewritten this session, and unchanged by the workflow because no agent can supply them:

- Supply Apple Developer ID signing and notarization credentials; run `pnpm release:signing:preflight`; build a signed DMG; mount it; let Gatekeeper evaluate it; run `scripts/test/desktop-mac-smoke.mjs` against the installed app.
- On a native Windows x64 host: build the NSIS installer, run `scripts/test/desktop-windows-smoke.mjs` (install, start, damage, repair, uninstall, retained-data comparison), and the DACL checks that are skipped on macOS. The `windows-2022` job in `.github/workflows/desktop-release.yml` exists for this and has never been dispatched.
- Run a real signed old-to-new update on both platforms (the harness proves admission, download, SHA-512, cancellation, downgrade refusal, and the restart lease against a local feed; the install step needs Electron and signatures).
- Rebuild the sealed desktop payload from the final source (`pnpm package:desktop:payload`) and record its hashes; the last recorded capture (50 files, Bridge 1.0.2) predates every change in this session.
- Chrome Web Store listing for Morrow Bridge; until then the Developer-mode "Load unpacked" step stands and the app cannot reload the extension itself (documented in the site's install steps and in `installer/UPDATES.md`).

---

## 11. Bridge, MCP runtime, multi-agent workflows: what is and is not shown

Shown by executing tests: three MCP clients sharing one runtime; ownership and conflict refusal across clients and action verbs; bounded, cancellable, attributed batch windows; restart recovery of durable batches; partial results preserved; `applied_or_unknown` never retried; the connector leaving with its assistant; handshake refusal with a close code; forty mixed Canvas and Moodle audits through concurrent clients (`program-scale.integration.test.ts`, which times out on this loaded machine, Section 7.2).

Not shown: two live signed-in courses connected at once; any assistant other than the Codex desktop workflow completing a live Canvas write; ChatGPT Remote or phone flows (deferred by Braden); the browser transport's inability to promise exactly-once provider effects after a dropped connection (`BROWSER-POST-TRANSPORT-LIMIT.md`), which is a documented contract limit, not a bug the workflow could remove.

---

## 12. Blackboard: what a tenant test needs

`docs/implementation/BLACKBOARD-REST-SCOPE.md` is the runbook. In one paragraph: a Blackboard administrator installs Morrow's REST application on the Learn site and chooses the account it acts as; the person enters the integration key and secret locally (the app keeps them in a private transaction, never in assistant config); Morrow verifies the acting principal through `users/me`, binds one tenant origin, one principal, one course; every read redacts learners; the one change operation freezes a patch for review and sends nothing; apply and verify are private. The entitlement list is recorded as unknown until a tenant confirms it. Test and question authoring is unavailable through the public Learn REST API (Anthology removed it in 3900.98), so parity with Canvas and Moodle on assessments is not possible by this route and the docs say so.

---

## 13. Moodle: the live-proof checklist

`docs/implementation/MOODLE-LIVE-PROOF-CHECKLIST.md` and `scripts/moodle-live-proof.mjs` were written for a person with a signed-in teacher account on a disposable Moodle course. The official hourly-reset Moodle 5.2 sandbox used before the freeze is the same place to run it. Question-bank authoring stays held until direct, latest-version, and random-reference impact can be scoped, exactly as before.

---

## 14. Things to preserve and things to know about the machine

Preserve: everything in Section 2.3; `output/` (gitignored, holds the website deployment staging copies, permission receipts, live-Moodle receipts); `work/handoff-2026-09-07/`; the backup copy under `.morrow-backups/`; the session scratch directory if the screenshots matter (about 300 MB).

Know: `.codex/config.toml` and `.gemini/settings.json` in the checkout point the assistants at this worktree's `packages/mcp-server/dist/index.js` with absolute paths; they were removed from the index on purpose. The pre-commit hook in this worktree runs the whole suite. Thirteen long-running Playwright Chrome processes from earlier Codex sessions are still up. The Codex app-server process from 5 September is still running and holds the thread-writer lock for the old Codex session.

---

## 15. Decisions and inputs only Braden can supply

1. Commit identity and hook handling (Section 2.5), then commit and push (Section 2.6).
2. Whether to run the workflow's verification stages now (Section 16, step 3) or hand the tree to a human review first.
3. The Moodle count reconciliation: by hand, or by the workflow's ledger stage.
4. Website: fix the 54 open verifier findings (Section 9.7; two are critical), then deployment (Section 9.6) and the GitHub 404 versus "open source" contradiction (Section 9.5).
5. Whether `canvas_send_private_conversation` is real and proven; if so, document it and let the site say so.
6. Signing and notarization credentials; a Windows x64 host; a Blackboard tenant with an administrator; an authorized Canvas course for the Item Bank live-proof plan; the deferred phone captures.
7. The `dataClass` decision for `canvas_read_course_file_signals` (Section 7.2 item 5).

---

## 16. Resume order

1. Read this file, then `work/handoff-2026-09-07/APPENDIX-A-work-items.md` for the lane you are touching, then the lane report under `work/handoff-2026-09-07/analysis/`.
2. Commit the two layers (Section 2.6) so the tree is reviewable. Do not push until the identity is right.
3. **Run the verification stages the workflow never reached.** Copy `work/handoff-2026-09-07/tools/` and `workflow/` somewhere durable, edit the paths at the top of `rebuild.py` and `monitor.py` to point at the new scratch and workflow directories, then `python3 rebuild.py` and launch the printed script with `Workflow({scriptPath, args: {root, scratch, lock, stamp: "2026-09-06", conc: 8}})`. With every item done or seeded, the script goes straight to Verify-Opus, then Fable, then Final-Checks with the serialized gate and its fix loop, then the critic and the ledger. Expect 4 to 6 hours and one or two session-limit interruptions; `rebuild.py` recovers from each.
4. If you would rather not run agents: fix Section 7.2 items 1 to 7 by hand (about a day), run the serialized gate (Section 7.3), and update `MORROW-REMAINING-WORK.md`.
5. Website: fix the 54 open verifier findings in Section 9.7 (a fixer agent given `website-journal.json` and `PLAN.md`, or a person with an afternoon), rerun `node --test scripts/test/website-content.test.mjs`, look at every page at 390 and 1440, then deploy (Section 9.6).
6. Rebuild the sealed payload; then the human-only items in Section 10, 12, and 13 as credentials and hosts arrive.

Do not start Docker. Do not automate the system Chrome. Use SSH only for ExamplePlatform and only read-only. Do not retry an uncertain LMS write. Do not delete the gitignored local directories.
