# Morrow 1.0 completion goal

Status: active. Renewed by Braden on 7 September 2026: finish the existing product, with a strict finish line and no unnecessary architecture work. This document is the completion contract. The September 7 handoff and its source Claude Code conversation were read before this final pass.

Working copy: `/Users/example/Projects/.morrow-worktrees/example-worktree`, branch `codex/example-worktree`. Current controller: Codex thread `01a07d77-2e08-7263-bf34-1634efa55c08`. Starting HEAD: `6c15a421a519ea94fd868aef1b3bb808a995f145`; fetched `origin/main` is its ancestor. Preserve the current dirty source, other user work, private receipts, captures and transcripts. Starting files, hashes and both diff layers are preserved in `output/final-pass-20260907/`.

## Strict definition of done — 7 September

All rows below must pass. A report that says an item was implemented does not close a row. Evidence must identify the tested source or artifact and the observed result. Existing scope in sections 1–8 remains in force. These rows define acceptance; they do not add a new architecture or another feature list.

| Required result | Acceptance evidence | Starting state |
| --- | --- | --- |
| Canvas support, including New Quizzes and Item Banks | All intended admitted routes are reachable through the shipped MCP and Bridge. Executing contract checks pass. Live disposable-course checks cover reads, create/update with exact saved-result comparison, files, assessments and the shared-bank repair path. Scope changes and uncertain outcomes cannot trigger a repeat write. Held routes name their actual contract or permission limit. | Implementation reported complete; independent review and new live proof open. |
| Full Moodle scope | The core-module, question, file, gradebook, learner, section, course and administration scope in `MOODLE-FULL-FUNCTIONALITY.md` is accounted for. Supported routes execute through MCP, review and Bridge, preserve unrelated fields and verify the saved result. Activity and section restrictions are implemented; verify their current contract. Live checks on a disposable teacher course cover the major form/executor families, including a reviewed file and gradebook change. Shared/random question writes remain refused only where affected uses cannot be bounded. | Most new routes have fixtures only; live proof open; restrictions have fixture proof. |
| Blackboard API support | The official Learn REST route starts, verifies the acting account, discovers real courses, applies exact tenant/course scope, protects learner data and performs reviewed changes with exact saved-result comparison. Mocked HTTP integration checks cover the admitted operation families and failure paths. Setup does not require a guessed principal ID. | Two setup/discovery steps open. No live tenant is available. |
| MCP and Bridge as an installed product | An actual supported assistant loads the packaged MCP, pairs Bridge, selects the intended course and completes a useful read. Two selected live courses can be used through the same runtime. Existing multi-client, 40-audit, cancellation, conflict, restart, privacy and uncertain-outcome checks pass. No success state relies on configuration files alone. | Source build passes; final integration and installed-client checks open. |
| Mac and Windows desktop app | Build final sealed artifacts. On the MacBook and native Windows `BOOTZ`, install and launch the app, complete first use, inspect the UI, reopen, repair, and test retained-data behavior using isolated QA state. Verify package hashes and runtime identity. Exercise update installation and recovery on both systems. | Native Windows host is reachable. Final artifacts and installed tests open. |
| Desktop distribution | Build and test unsigned Mac and Windows installers, as Braden explicitly directed on 7 September. Published downloads and any update metadata must match the tested artifacts and identify the version, platform and architecture. Unpacked Bridge setup may use the already-authorized temporary developer-mode flow. | Final unsigned artifacts and native verification open. Signing is out of scope. |
| Finished website | Resolve the 54 recorded findings by a source fix or a documented evidence-based dismissal. Preserve the established brand and page purpose. Inspect all pages at 390 and 1440, and shared layouts at 320, 768 and 1024. Check navigation, links, keyboard use, reduced motion, dark mode, policies and 404. Examples use `Your Assistant using Morrow`, remain plausible and match actual capabilities. Install/download text matches verified artifacts. Deploy the finished site through the existing authorized route and verify both domains. | Rewritten site is local; recorded findings and final rendered checks open. |
| Final integration and closure | Fix confirmed defects with narrow changes. Run `pnpm check` and the relevant catalog, packaging, provenance and browser gates on the final source. Resolve failures; do not weaken checks to obtain green. Reconcile README, LIMITATIONS and the remaining-work ledger to actual evidence. Keep website and marketing outside the public code repository. | Broad gate and documentation reconciliation open. |

Blackboard has one accepted verification exception: no live tenant test is required. Its API contract tests must pass, and the limitation must remain explicit. Public Learn REST assessment-authoring limits are provider limits, not promised functionality. Connect/MindTap and the deferred phone captures remain outside this finish pass as previously directed. Braden explicitly excluded Apple and Windows signing credentials on 7 September. Unsigned installers are the required deliverables. Signing, notarization and signed-update proof are not completion gates; this correction overrides the older signing requirements below. Do not request those credentials again.

At 22:02 UTC on 7 September, Braden explicitly rejected signing, unsigned-build, and internal release-status language across the public website. Research established consumer product sites. Write the entire site for people choosing, installing and using Morrow. Keep engineering status and validation records in the internal release evidence. This correction overrides the older website proof-status copy contract.

Work stops when these acceptance rows pass, or when only a named owner-supplied input remains after all independent work is complete. Do not restart analysis, expand architecture, create another workflow engine, add unrelated features, or keep polishing after the requested result and its checks pass. An unresolved required row means Morrow 1.0 is not complete.

## The requested result

Braden's controlling positioning: give faculty time back and connect them to the course information and actions needed for informed teaching decisions. Democratize LMS data, capabilities, and modern agentic workflows through an open-source connection to the assistant each person chooses. He explicitly rejected "course team," abstract "capacity" headlines, and oversized type. State what Morrow does in clear words and show substantial examples. The current positioning brief is `.agents/product-marketing.md`.

Deliver Morrow as an open-source consumer product that regular people can install, understand, trust and use. The product must be useful across course teams and many courses. Its desktop app, installation, updates, browser connection, permissions, settings, reviews, results, website, support and media must feel like one carefully made product. Complete implementation and verification. A plan, attractive prototype, route catalog or passing test does not meet this goal.

This goal includes the full unfinished Canvas, Moodle, Blackboard, privacy, multi-course and concurrent-assistant scope in [MORROW-REMAINING-WORK.md](MORROW-REMAINING-WORK.md), [MOODLE-FULL-FUNCTIONALITY.md](MOODLE-FULL-FUNCTIONALITY.md) and [THREE-LMS-BRIDGE-PARITY.md](THREE-LMS-BRIDGE-PARITY.md). A smaller finished component must not replace that scope.

## User corrections that must not be lost

Braden has repeatedly rejected technical setup presented as a consumer experience. These are release requirements, not optional copy changes.

- Build an **actual guided installer for Mac and Windows**. Both platforms are required. A macOS-only UI or an MCP ZIP is insufficient.
- Regular users must not run commands, open Terminal, edit configuration files, type paths, install Node or pnpm, build source, manage tokens, or start a separate service.
- The previous command-based first-run page and extracted ZIP instructions were rejected. Keep their engineering receipts as historical evidence; do not ship them as the normal installation.
- The only current exception is the user's explicit permission for a **temporary Developer mode / Load unpacked installation of Morrow Bridge** until its Chrome Web Store listing is finalized. The app must make this step visual and clear. Use a real Show Bridge folder action and native folder selection. No commands or path typing. This exception does not apply to any other part of setup.
- The CWS publisher account uses `hello@example.com`. Chrome Web Store installation and automatic extension updates remain the intended final route.
- Apple-level polish applies to **every surface**, including both platform apps and all failure, recovery, installation and update screens. It is not limited to the marketing site.
- Use clear education benefits and plain language. Avoid “AI app,” generic slogans, empty labels, technical placeholders and implementation details that do not help the user decide.
- **No empty taglines, slogans, subtitles, or eyebrow labels.** Braden explicitly required Impeccable on 6 September after rejecting “Desktop setup” and “Ready for a first read.” Each line must explain a function, action, result, or useful constraint. A different slogan does not fix the problem.
- Morrow is a **consumer product for Mac and Windows**, not a “private preview.” Product access must work with Canvas and Moodle courses that the user can access. Internal test-course restrictions are verification controls, not customer eligibility or tenant restrictions.
- Build an **actual multi-page website**. A landing page plus policy pages does not meet the request. Include useful product, capabilities, remote-use, setup, and download pages, and dedicated pages for Instructors, Instructional Designers, LMS Administrators, Curriculum Developers, and QA teams. Explain distinct tasks and results for each role.
- Show what Morrow can do through natural, specific conversations. Do not replace capability demonstrations with metadata, finding tables, canned future-tense replies, or repeated permission explanations.
- Show work that expands an individual educator's abilities: recurring outreach in their voice, custom analytics across assignments and sections, discussion participation and timing patterns, complete course creation, and program-wide curriculum or accessibility work. Braden explicitly rejected basic next-item and single-date lookup chats. This applies to every role, homepage, remote, and general website example. Keep the full depth of the product while grounding exact execution and scheduling claims in their real contracts.
- Fill pages with extensive useful content. Full workflows, examples, outputs, methods, and practical questions must explain the product in depth. Minimal content is not a design goal. In every example chat, Morrow appears left and the user appears right.
- Explain remote use through **ChatGPT Remote and Claude Code Remote Control** prominently, with a dedicated page and homepage section. The deferred phone recordings do not justify omitting the feature. State the real host and permission requirements. Preserve the distinction between documented provider support and pending Morrow phone verification.
- Keep MCP and Bridge implementation, adversarial checks, native installers, and live function verification running **in parallel** with the website. Website work does not replace completion of the course functions.
- Remove needless fixed-title wraps. Keep exact course names and values readable. Do not hide them, reduce type into illegibility, or harm keyboard and screen-reader use to force a line.
- Check actual text wrapping across every website and app page. Braden again rejected narrow heading columns next to unused space on 6 September. Use the available width, remove unnecessary text-width constraints and empty companion columns, and inspect real headings at desktop, tablet and phone widths. Shorter copy must remain meaningful; it cannot hide a broken layout.
- Use the established knot, Manrope, cobalt, cool white and chartreuse brand with deliberate space, alignment, hierarchy, iconography and restrained motion. Follow Mac and Windows conventions where they differ.
- Do not show invented progress, a connected badge based only on a file write, a fake download link, a made-up integration, or a “ready” state that has not been proved.
- Anticipate real problems. Confirm root causes, make narrow fixes, and prove the regression. Do not stop at another plan or ask again for authority already given.
- Do not re-raise an issue that Braden has said is fixed.
- Do not use Fable. The user stopped that lane. Remaining iPhone capture and video work is deferred until tomorrow; preserve the existing authentic captures and do not call their unsent prompts operation proof.

## 1. Build the complete desktop installation and first-run flow

Use one shared Electron app with a macOS DMG and a guided Windows NSIS installer. Reuse the working Morrow MCP, connector, approval and privacy contracts. The app manages the internal services; the user installs one Morrow app plus the Bridge. Avoid a second account system, billing flow or hosted course-data service that this task does not need.

The normal path is Welcome → choose an installed assistant → connect Morrow → install and pair Bridge → select an exact signed-in course → complete a useful read-only first preview. Add guidance at the step where it is needed. An optional fuller guide may explain the same flow; it must not change permissions or defaults.

Detect supported assistants from actual installation evidence. Use their current official configuration or native extension contracts. A configured command is not proof that the assistant loaded it. Confirm the actual assistant can start and use Morrow. Distinguish assistant registration, runtime health, Bridge pairing, exact selected-course readiness and successful first course read. Missing or unavailable integrations need a clear next action. Do not silently write an unverified Windows Claude Desktop configuration location.

Provide an optional native materials-folder picker. Default to a dedicated empty Morrow materials folder. Bind each client to its exact canonical folder. Do not expose the whole home directory, signed resources or private state as a fallback. Keep the application, material access and state locations separate. Preserve current project-scoped behavior for developer users where it remains supported.

Merge assistant configuration safely. Preserve unrelated settings and formatting. Detect valid quoted TOML and inline-table forms, malformed inputs and existing Morrow conflicts. Bind the preflight, intended write and readback to the exact target. Make private backups. A later failure must not restore a backup over another process's newer edit. Handle existing installs and repeated clicks without duplicates or corruption.

Executable resources must retain an integrity and signing contract. Keep keys, journals, learner maps and connection state in the user's private application-data location, outside signed resources. Updates must preserve that state. Configuration paths that assistants use must remain valid across installation, relocation and upgrades.

Include reopening/resuming setup, adding or removing assistants, changing the materials folder safely, repairing the connection, useful support information, and an understandable uninstall and data-retention flow. Read current state on reopen. Do not require the user to diagnose internal process names, ports or configuration files.

Completion requires the actual packaged installer on native Mac and native Windows. Test the fresh-user path without the source checkout or global developer tools. Inspect the resulting app. Exercise supported assistants, Bridge pairing, exact course selection, first read, shutdown, repair and uninstall. An isolated SDK smoke is supporting evidence, not complete consumer proof.

## 2. Implement safe automatic updates for the app and Bridge

Use a maintained update system with a real owned distribution route. The existing repository and Cloudflare account are available release candidates, but a URL string alone is not an update service. Bind every release to version, platform, architecture, source and artifact hashes. Verify platform signatures and update authenticity before installation. Do not duplicate guarantees that the update library already provides; verify that the actual configuration enables them.

The app must check, download, verify, stage and install an update through a clear flow. Use accurate progress from actual work. Make restart timing understandable. Handle offline state, cancelled or interrupted downloads, corrupt content, signature failure, inappropriate downgrade, wrong architecture, insufficient space, concurrent app starts and a failed new-version launch. Stage atomically. Keep a working version and recovery path. Preserve keys, journals, learner mappings, course bindings, materials roots, assistant settings and the exact authority already granted.

Every desktop release must update its bundled MCP runtime as part of the same signed atomic artifact. Bind the MCP package version, entrypoint, dependency tree and file hashes in the immutable payload manifest. Keep assistant configuration on the stable installed path. After restart, require the gateway health response to prove the new MCP version and payload digest before reporting the update complete. Preserve private state and never replay a pending or uncertain operation during migration.

Never restart or replace a runtime during active or uncertain course work. Never automatically replay a pending effect after an app or Bridge update. Coordinate app and Bridge protocol versions. Show a useful version-mismatch state and safe recovery. An update cannot silently widen course access, change Plan to Edit, enable another edit category, or bypass Chrome's permission review.

For a temporary unpacked Bridge, use a stable, app-owned extension location with verified contents. Determine and test Chrome's supported reload behavior before promising automation. Update only this product's files. Preserve connection and permission state through a compatible update. If a person must reload or approve in Chrome, guide that exact step and verify it; do not claim silent updating.

For a CWS installation, Chrome owns installed extension files and updates. The app may use a documented, bounded update check or show status. It must not overwrite Chrome's installed files, replace the Store extension with an unpacked copy, bypass permission prompts, or imply that a Store review has completed when it has not.

Braden explicitly excluded Mac and Windows signing on 7 September. Ship unsigned installers with accurate status. Automatic updates that require platform signatures remain disabled for unsigned builds. Verify manual installer replacement, retained state, repair and recovery on each native platform. Do not request signing credentials.

Completion requires an actual old-version → new-version update on both native platforms, with configuration and privacy-state preservation, continued assistant and Bridge operation, failure recovery, and proof that active or uncertain work is protected. Include independent tamper and interruption checks.

## 3. Finish privacy, permissions and exact operation control

Keep the private roster and stable learner-token context bound to the exact origin, account, principal, course, browser session and client. Minimize known learner identities before every assistant-bound result: structured records, prose/HTML, nested objects, resources, reports, errors, sampling, retained artifacts and historical operation inspection. Refuse incomplete rosters and missing or ambiguous scope without a raw fallback. Test concurrent scopes, Unicode, stale state and restart. Do not claim universal PII detection.

Keep sign-in cookies and credentials in Chrome. Prevent secrets and identities from entering diagnostics, public assets, update requests, release logs and support bundles. Preserve encrypted learner mappings and retained learner reports. Describe unencrypted operation records, retention and the assistant provider's own data rules accurately.

Study the proven legacy Morrow and SSH-only ExamplePlatform implementations where useful. Record provenance and verify the adapted boundary. Do not clone restricted donor code or treat a historical behavior as current proof.

Plan remains the safe default. Edit grants require the person's exact confirmation, selected course bindings, permitted categories, expiry and revocation. Generic assistant approval is not Morrow authority. Preserve due-date-only scope, unsupported and stale refusal, cancellation, one explicit Morrow dispatch, saved-state readback and replay refusal after uncertainty. The browser transport can repeat a POST after a lost connection; do not promise exactly-once provider effects.

## 4. Complete program-wide Canvas work

Inventory all readable selected-course surfaces and persist exact scope and evidence. Include Pages, Assignments, Discussions, linked materials and Files, Classic Quiz content, New Quiz instructions and questions, choices, answers, feedback, stimuli, media and readable Item Bank entries.

Produce useful accessibility, design, curriculum and QA findings. Keep target, field, digest, criterion, learner effect and evidence together. Supported repairs must preserve unrelated course content and settings, require proper human control, dispatch once, reread the saved target, recheck the finding and inspect the learner-facing result.

Resolve incomplete Classic, Stimulus and shared-bank writer and impact contracts from authoritative native evidence. Do not invent an available writer or assume a bank change affects only one course. Read actual file bytes before document, PDF, Office, image or media claims. Keep keyboard, focus, link purpose, contrast, tables, equations, captions, transcripts, player controls and interaction checks explicit where source parsing is insufficient.

Each discovered item needs an honest result: repaired and verified, manually checked, not applicable with evidence, unread, held or blocked. An empty response, partial inventory or four source signals cannot become a passed course or accessibility-conformance claim.

## 5. Complete Moodle and establish Blackboard

Complete the full Moodle contract, including core modules, authorable question types, shared/random Question Bank impact, file creation and replacement, folders, editor/question/feedback attachments, gradebook and learner work, dates, completion, restrictions, reports, course lifecycle and administration. Each function needs a native action/form contract, explicit role and capability scope, protected-field preservation, exact target binding, reviewed dispatch, fresh saved readback and replay refusal.

Current selected module, file and activity-move proofs do not establish full Moodle. The new gradebook path still needs final-artifact live-write proof. Hold question writes where references and random selections cannot be bounded. Optional plugins need their own installed-site contracts.

Braden clarified on 6 September that he has no Blackboard test course. Implement Blackboard through the official Anthology REST API, with local credentials, exact tenant and course binding, scoped reads, reviewed writes, fresh saved-result comparison, privacy controls and refusal states. Verify these contracts with mocked HTTP integration tests. Clearly mark the integration as untested on a live Blackboard tenant. A test course is not a release prerequisite. Do not inherit Canvas or Moodle live claims or require a browser/PKCE route for Blackboard.

Keep Connect and MindTap excluded until written provider permission or an authorized integration contract exists. A route inventory or legal research is not that permission.

## 6. Prove many-course and concurrent-assistant work

Support dozens of selected courses without one tab per course. Preserve exact account/course/client roots and token isolation, durable ownership, object conflict locks, bounded concurrency, cancellation, partial results, restart and retained reports. Keep every child outcome visible. A batch cannot be called successful while a child remains uncertain.

The existing 40-audit, three-client fixture is useful evidence. It does not prove customer scale or either final platform installer. Complete native multi-client and multi-course proof. Recover uncertain operations through safe read-only provider evidence only where an authoritative comparator exists. Otherwise preserve the unconfirmed state and prevent replay. App repair, update and uninstall must honor the same lifecycle constraints.

## 7. Finish the public product and open-source delivery

Maintain the polished website at `meetmorrow.app` and `www.meetmorrow.app` on the existing Cloudflare Pages project `meetmorrow`. Website publication is explicitly authorized. Finish live rendered inspection, navigation, policy routes, 404 behavior, responsive layouts, keyboard use and reduced motion. Keep the small GitHub star link and ensure it reaches an actually accessible repository when publication is approved.

The website must have a clear navigation hierarchy and distinct, complete pages. Show each audience's actual course tasks, outputs and examples. Research current established product sites for information structure, then use Morrow's own visual identity and content. Do not invent testimonials, customers, performance statistics, release availability, broad platform coverage or a paid plan. A credible site comes from complete, useful content and working navigation. The exact revised page map and content contract are in `MORROW-WEBSITE-BRIEF.md`.

Keep Privacy, Terms, Support and Security coherent and tied to actual source behavior. `hello@meetmorrow.app` forwards to `hello@example.com`; the enabled rule and DNS have authoritative readback, but a delivery test has not been sent. Do not claim tested delivery.

Audit exact source, Git history and release payloads before public source publication. Do not stage broadly: this worktree contains private bundles, browser captures, configuration and evidence among many untracked files. Preserve license and source provenance. Use exact allowlisted source staging, clean release payloads and required approval for irreversible visibility. Refresh current GitHub state before acting.

Keep downloads, platform labels and availability tied to actual signed, tested artifacts. Do not publish the rejected ZIP as Morrow 1.0. Keep the five established benefit scenarios, led by program-wide audit and repair. Use authentic course and product captures and distinguish examples from recorded proof. Update the desktop film and website from final behavior. Keep phone capture deferred until the user resumes it or its scheduled day arrives.

## 8. Independent adversarial verification and completion

Challenge every changed critical journey and trust boundary. Relevant cases include untrusted course content, identity leakage, scope confusion, stale accounts, revocation, denied permissions, malformed or conflicting assistant configuration, concurrent edits, traversal and symlinks, state isolation, IPC and sender validation, unsafe navigation, update tampering/downgrade, damaged downloads, migration, duplicate launch, interrupted work and uncertain-effect recovery.

Use bounded independent assignments with exact ownership. Integrate findings, fix root causes and prove the regression. Run existing focused checks, the repository's authoritative `pnpm check`, required packaging/provenance gates, native Mac and Windows checks and real installed-artifact tests. Repeat or broaden checks when a new change, failure or unresolved concern warrants it.

Inspect after-screenshots of both desktop apps and the actual public site. Include narrow layouts, long names, keyboard/focus, reduced motion and all relevant error and success states. Test the ordinary user path without a developer's preconfigured environment, except the explicitly permitted temporary Bridge installation.

For live effects, bind evidence to the exact artifact and target. Require fresh authoritative provider readback and independent dispatch/replay evidence. An HTTP 200, create response, generated receipt, local SDK health check, test fixture or older ZIP is not complete proof.

Reconcile source, documentation, public claims, release/update artifacts, hashes and receipts. Report current verified results and material limits. Do not mark this goal complete while required functionality or verification remains, because a budget or deadline is near, or because one component is polished. Resolve researchable questions without asking Braden. Ask only for genuinely missing user-owned facts, account access, a material scope decision or required final approval. Continue independent authorized work while an external input is pending.

## Current evidence and ownership

The current public site deployment is `8939b211-e1a7-4285-9381-d0575279ccca`. All 35 public files matched staged hashes on its immutable deployment URL and both custom domains on 6 September. The homepage now uses one-pass conversation reveal without the illustration label or playback control, as requested. Clean policy URLs and `Cache-Control: no-transform` corrected a live redirect loop and an injected-script/CSP conflict. Rendered inspection remains part of final website verification.

The last full source gate before the new desktop work passed: `output/morrow-check-2026-09-06-onboarding-final-r3.log`. It does not cover subsequent installer, state, configuration or update changes. Previous package, iMac and live Moodle receipts remain evidence for their stated versions only.

Current desktop evidence for §1 and §2, by exact path. Nothing here is signed, notarized, or published, and no status above is upgraded by it:

| Claim | Saved receipt | What it does not cover |
| --- | --- | --- |
| A macOS Apple silicon application builds from this checkout | `output/morrow-desktop-qa-mac/receipt.json` (`morrow.desktop-installer.v1`, `signing.mode: unsigned_private_qa`), with the DMG, ZIP and `latest-mac.yml` digests | Signing, notarization, Gatekeeper, and mounting the disk image |
| That application starts, verifies its sealed payload, answers gateway health, and keeps State and the Codex configuration inside a contained root | `output/desktop-mac-smoke-2026-09-06/receipt.json` and `receipt.harness.json`, written by `scripts/test/desktop-mac-smoke.mjs`; `output/desktop-mac-smoke-2026-09-06/README.md` records the commands | The Chrome bridge listener: port 32147 was already held, so `portBinding` was `unbound` on that run |
| A damaged payload is refused rather than started | `output/desktop-mac-smoke-2026-09-06/incomplete-payload/app-receipt.json` and `harness-stderr.txt` | Nothing further; the harness exited 1 and wrote no receipt at the requested path |
| The sealed payload binds the MCP package version, entrypoint, dependency tree and every shipped file hash | `output/desktop-payload-2026-09-07/receipt.json` and its `README.md`, with `app/package-input-manifest.json` as the binding record | The commit alone: the tree was dirty, so `inputManifestSha256` identifies the source, not `6c15a421a` |
| Claude Desktop registers and deregisters the generated `.mcpb` bundle | `output/desktop-claude-native-2026-09-06/native-install.json`, `native-install-r2.json`, and the matching `native-uninstall*.json` | Bridge pairing and course writes; the receipts record `bridgePaired: false` and `courseWrites: 0` |
| The Windows installer installs, starts, repairs a damaged payload, uninstalls, and keeps retained data | No saved receipt in this checkout. `scripts/test/desktop-windows-smoke.mjs` runs on native Windows only, through the manually dispatched `windows-2022` job | Everything: Windows results stay live-unverified here |
| An old-to-new update installs on either platform | No saved receipt. `scripts/test/desktop-update-harness.test.mjs` drives the real `electron-updater` library against a local static feed and records the `quitAndInstall()` call instead of performing it | The install step, macOS notarized verification, and the Windows publisher-signature check, which all live in `MacUpdater` and `NsisUpdater` |

| Owner | Bounded responsibility |
| --- | --- |
| Root | Integration, full scope, account/signing discovery, exact publication, live proof and final gates |
| `installation_finish` | Electron main/preload, installer packaging, bundled runtime targets and update integration |
| `launch_desktop` | Installer renderer, Bridge onboarding, design and rendered verification |
| `canvas_repairs` | Client configuration, safe materials/state options and configuration regression checks |
| `privacy_closure` | Shared update engine, maintained updater integration and focused failure tests |
| `program_scale_review` | Native Windows release workflow and installed-package smoke harness |
| `privacy_review` | Independent installer/update privacy, trust and lifecycle review |

Follow the user's operational boundaries: no Fable, no Docker, no automated launch of system Chrome, ExamplePlatform only through SSH to `example-lms-vps`, no unauthorized messages, no destructive cleanup and no transcript loss.
