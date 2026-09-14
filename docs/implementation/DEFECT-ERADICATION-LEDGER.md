# Morrow defect-eradication ledger

Baseline audit: 82 defects at `d262ac47571dbba8a617f47b80ec7223c4ab46bd`. Fresh adversarial discovery adds every later numbered defect to this same ledger.

Status terms:

- `OPEN`: validated against the baseline and not repaired.
- `IN_REPAIR`: a root repair is being implemented.
- `IMPLEMENTED`: source and focused regression are complete.
- `VERIFIED`: focused checks, broad integration gate, and direct inspection passed.
- `BLOCKED`: an external fact or platform prevents verification. The implementation is not treated as complete.

Every row stays open until its evidence columns are added and its status becomes `VERIFIED`.

## Root families

| Family | System failure | Long-term control |
| --- | --- | --- |
| R1 Exact effect identity | Verification accepts value similarity, caller substitution, or unrelated evidence. | One typed effect target and one frozen verification plan bind source, account, course, provider identity, pre-state, request fields, and readback. |
| R2 Durable authority transaction | Batch, approval, cancellation, rollback, and staging state cross stores without one terminal transition. | Transactional admission plus idempotent compensation; dispatch reserves only authority whose complete parent chain is active. |
| R3 Typed privacy projection | Generic recursive logic guesses identity from scalar values or incomplete rosters. | Typed provider results, exact-course identity contexts, linear-time text projection, and immutable projection snapshots for artifacts. |
| R4 Provider contract fidelity | Local schemas normalize away official IDs, fields, empty values, pagination tokens, or native UI state. | Contract adapters preserve provider values and validate only explicit invariants; generated fixtures come from the same contract source. |
| R5 Protocol and session lifecycle | Framing, negotiation, continuation, cancellation, generation, and replay state diverge across layers. | Shared codecs and cancellable single-use session primitives with generation binding and end-to-end tests. |
| R6 Desktop state ownership | Setup, repair, refresh, rollback, and removal infer identity or ownership from names and mutable snapshots. | Durable state machine with canonical client identity, compare-and-swap configuration receipts, and explicit removal tombstones. |
| R7 Release evidence graph | Release predicates accept cached, unrelated, pre-transform, or unresolved evidence. | Content-addressed evidence graph binding source, staged bytes, dependencies, artifacts, authorization, current readback, and deterministic rebuild. |
| R8 Bounded execution | Local status, redaction, scheduling, and recovery can starve or fan out without bounds. | Ready-work scheduling, shared source contexts, fixed concurrency budgets, and measured worst-case gates. |
| R9 Accessible interaction identity | Repeated controls, changing views, or hidden context leave the assistive name, focus target, or announced state ambiguous. | Bind every action's accessible name and focus identity to its exact visible target, and verify the rendered interaction through the same state transitions users receive. |

## Defects 1–19

| ID | Sev | Family | Defect | Primary source | Status |
| ---: | :---: | :---: | --- | --- | :---: |
| 1 | P1 | R1 | Unrelated caller-supplied readback can verify an uncertain write. | `packages/mcp-server/src/runtime.ts:7114-7116,7597-7604` | IMPLEMENTED |
| 2 | P1 | R2 | Cancelled batch retains an approved outer operation that can dispatch. | `packages/operation-journal/src/effect-broker.ts:729-832,899-905`; `packages/mcp-server/src/morrow-runtime.ts:2078-2086` | IMPLEMENTED |
| 3 | P1 | R1 | Mixed New Quiz writes verify only settings or order and skip other requested fields. | `connector/extension/src/canvas-content.js:2087-2127,2648-2672` | IMPLEMENTED |
| 4 | P1 | R2 | Remove data deletes an active journal without the authoritative maintenance lease. | `installer/shared/installer-controller.cjs:1183,1360` | IMPLEMENTED |
| 5 | P2 | R8 | Batch scheduler starves ready children when earlier limited rows have unmet dependencies. | `packages/batch-engine/src/index.ts:1537` | IMPLEMENTED |
| 6 | P2 | R1 | Another course's read can satisfy person close-out and release a target hold. | `packages/mcp-server/src/runtime.ts:7746` | IMPLEMENTED |
| 7 | P2 | R4 | Classic Quiz image-alt repair rejects ordinary official response fields. | `packages/mcp-server/src/page-correction.ts:841` | IMPLEMENTED |
| 8 | P2 | R4 | Canvas form encoding drops an explicitly empty description. | `connector/extension/src/canvas-content.js:2812` | IMPLEMENTED |
| 9 | P2 | R1 | Outcome unlink verification reads `id` instead of `outcome.id`. | `packages/canvas-api-catalog/src/readback-plan.ts:162` | IMPLEMENTED |
| 10 | P2 | R6 | Payload verification accepts damaged executables that the installer launches. | `installer/shared/runtime.cjs:125` | IMPLEMENTED |
| 11 | P2 | R6 | Claude Code setup changes an existing project directory from `0775` to `0700`. | `packages/client-config/src/index.ts:755` | IMPLEMENTED |
| 12 | P2 | R6 | macOS setup misses native Claude Code at `~/.local/bin/claude`. | `installer/shared/installer-controller.cjs:208` | IMPLEMENTED |
| 13 | P2 | R6 | Cross-target packaging does not pass the Windows target to electron-builder. | `scripts/package-mcp-bundle.mjs:717` | IMPLEMENTED |
| 14 | P2 | R2 | Two approval tabs invalidate each other's nonce. | `packages/mcp-server/src/approval-server.ts:987` | IMPLEMENTED |
| 15 | P2 | R6 | Private Chat modal lets focus reach covered permission controls. | `connector/extension/settings/settings.js:123` | IMPLEMENTED |
| 16 | P2 | R7 | Source readiness omits provider-specific live proof and authorization requirements. | `scripts/lib/release-candidate.mjs:18` | IMPLEMENTED |
| 17 | P2 | R7 | Final conformance trusts cached live/client evidence after authoritative receipt removal. | `scripts/lib/release-candidate.mjs:889` | IMPLEMENTED |
| 18 | P2 | R7 | Release tooling reports version `1.0.0` for the `1.0.4` source. | `scripts/lib/release-candidate.mjs:17` | IMPLEMENTED |
| 19 | P3 | R7 | Lower-level release API can report ready without verified deterministic rebuild. | `scripts/lib/release-candidate.mjs:724` | IMPLEMENTED |

## Defects 20–41

| ID | Sev | Family | Defect | Primary source | Status |
| ---: | :---: | :---: | --- | --- | :---: |
| 20 | P1 | R1 | Blackboard assignment create can verify from a pre-existing grade column. | `packages/blackboard-learn-api/src/operations/assignments.ts:568` | IMPLEMENTED |
| 21 | P2 | R3 | A resource whose ID matches a learner ID is mistaken for that learner. | `packages/gateway-core/src/privacy.ts:802` | IMPLEMENTED |
| 22 | P2 | R3 | String resource IDs become learner labels in structured output. | `packages/gateway-core/src/privacy.ts:636` | IMPLEMENTED |
| 23 | P2 | R3 | Private Chat replaces ordinary scores that match roster IDs. | `connector/extension/src/protected-request.js:157` | IMPLEMENTED |
| 24 | P2 | R8 | Quadratic redaction consumes its own 60-second roster window. | `packages/gateway-core/src/privacy.ts:616` | IMPLEMENTED |
| 25 | P2 | R1 | Program ledger accepts another target's audit or re-audit evidence. | `packages/mcp-server/src/program-ledger.ts:328` | IMPLEMENTED |
| 26 | P2 | R3 | Program ledger ignores 14 of 18 source-signal categories. | `packages/mcp-server/src/program-ledger.ts:187` | IMPLEMENTED |
| 27 | P2 | R3 | Program ledger drops the artifact audience and cannot read the client's inventory. | `packages/mcp-server/src/program-ledger.ts:638` | IMPLEMENTED |
| 28 | P2 | R4 | Blackboard membership parser requires `id` while the provider returns `userId`. | `packages/blackboard-learn-api/src/client.ts:418` | IMPLEMENTED |
| 29 | P2 | R4 | Blackboard content paths require `courseId` absent from the response contract. | `packages/blackboard-learn-api/src/runtime.ts:286` | IMPLEMENTED |
| 30 | P2 | R4 | Blackboard assignment creation reads `gradebookColumnId` instead of `gradeColumnId`. | `packages/blackboard-learn-api/src/operations/assignments.ts:470` | IMPLEMENTED |
| 31 | P2 | R4 | Blackboard announcement duration enums have no overlap with provider values. | `packages/blackboard-learn-api/src/operations/announcements.ts:76` | IMPLEMENTED |
| 32 | P2 | R4 | Blackboard grade reads omit ordinary displayed score and text fields. | `packages/blackboard-learn-api/src/operations/gradebook.ts:35` | IMPLEMENTED |
| 33 | P2 | R4 | Moodle `format_options` can change protected course settings. | `connector/extension/src/moodle-course-settings-executor.js:629` | IMPLEMENTED |
| 34 | P2 | R4 | Empty Moodle Lesson refuses creation of its first page. | `connector/extension/src/moodle-lesson-executor.js:419` | IMPLEMENTED |
| 35 | P2 | R3 | macOS credential hardening preserves inherited access grants. | `packages/gateway-core/src/private-file-access.ts:151` | IMPLEMENTED |
| 36 | P2 | R3 | Saved result becomes unreadable after its captured roster ages past 60 seconds. | `packages/mcp-server/src/result-artifacts.ts:154` | IMPLEMENTED |
| 37 | P2 | R4 | Canvas upload requests duplicate-name rename, then rejects the renamed result. | `connector/extension/src/canvas-file-transfer.js:32` | IMPLEMENTED |
| 38 | P2 | R6 | Desktop runtime monitor retains a dead client and cannot reconnect it. | `installer/shared/runtime-monitor.mjs`; `installer/test/runtime-monitor.test.mjs` | IMPLEMENTED |
| 39 | P2 | R5 | Owner connection failure leaves stdio proxy alive but silent. | `packages/mcp-server/src/local-owner.ts`; `packages/mcp-server/test/local-owner.integration.test.ts` | IMPLEMENTED |
| 40 | P2 | R5 | Development Bridge calls native `crypto.randomUUID` without its receiver. | `connector/extension/src/bridge-maintenance.js:71` | IMPLEMENTED |
| 41 | P3 | R2 | Multi-file staging failure loses cleanup handle and retains an unbound file. | `packages/mcp-server/src/runtime.ts:2033-2040,2071-2076` | IMPLEMENTED |

## Defects 42–55

| ID | Sev | Family | Defect | Primary source | Status |
| ---: | :---: | :---: | --- | --- | :---: |
| 42 | P2 | R6 | Setup rejects valid commented Gemini and VS Code configuration files. | `packages/client-config/src/index.ts:1072` | IMPLEMENTED |
| 43 | P2 | R6 | Remove reports success while a quoted Codex TOML server table remains active. | `installer/shared/installer-controller.cjs:267` | IMPLEMENTED |
| 44 | P2 | R6 | Failed multi-client setup rollback can delete a concurrent user edit. | `installer/shared/installer-controller.cjs:1007` | IMPLEMENTED |
| 45 | P2 | R5 | UTF-8 split across stdio reads is replaced with corrupt text. | `packages/mcp-server/src/strict-stdio.ts:20` | IMPLEMENTED |
| 46 | P2 | R5 | Shared-owner route cannot negotiate the modern MCP protocol. | `packages/mcp-server/src/local-owner.ts`; `packages/mcp-server/test/local-owner.integration.test.ts` | IMPLEMENTED |
| 47 | P2 | R5 | Native-name reservation omits newer native tools and permits duplicate registration. | `packages/mcp-server/src/runtime.ts:281` | IMPLEMENTED |
| 48 | P2 | R2 | Cancelling the last queued run deletes the active batch's serialization tail. | `packages/mcp-server/src/batch-window-scheduler.ts:480` | IMPLEMENTED |
| 49 | P2 | R8 | Accepted `Retry-After` state is discarded between batch windows. | `packages/batch-engine/src/facade.ts:305` | IMPLEMENTED |
| 50 | P2 | R4 | Optional Item Banks discovery consumes the host-permission user gesture. | `connector/extension/src/service-worker.js:4412` | IMPLEMENTED |
| 51 | P2 | R6 | Check or switch course silently clears selected courses and Edit policies. | `connector/extension/src/service-worker.js:4566` | IMPLEMENTED |
| 52 | P2 | R6 | Desktop refresh restores focus by action name instead of course ID. | `installer/renderer/renderer.js:88` | IMPLEMENTED |
| 53 | P2 | R1 | Hot Spot internal verification is overwritten as no safe outer readback route. | `connector/extension/src/canvas-new-quiz-hot-spot.js:33`; `connector/extension/src/service-worker.js:4206` | IMPLEMENTED |
| 54 | P2 | R4 | Item Banks hardcodes external-tool deployment ID `54065`. | `connector/extension/src/item-bank-credential.js:2` | IMPLEMENTED |
| 55 | P3 | R6 | Bridge Settings ignores course-tab status events until manual refresh. | `connector/extension/settings/settings.js:1440` | IMPLEMENTED |

## Defects 56–82

| ID | Sev | Family | Defect | Primary source | Status |
| ---: | :---: | :---: | --- | --- | :---: |
| 56 | P1 | R1 | Moodle enrolment can claim Student while the saved role is different. | `connector/extension/src/moodle-enrolment-executor.js:660-689` | IMPLEMENTED |
| 57 | P1 | R1 | Unrelated Moodle activity can falsely verify a rejected course import. | `connector/extension/src/moodle-backup-executor.js:805-864` | IMPLEMENTED |
| 58 | P1 | R1 | Pre-existing Blackboard group can falsely verify a failed create. | `packages/blackboard-learn-api/src/operations/groups.ts:905-917` | IMPLEMENTED |
| 59 | P1 | R3 | Blackboard account-wide course discovery can expose another course's learner name. | `packages/blackboard-learn-api/src/operations/course-contents.ts:131-171` | IMPLEMENTED |
| 60 | P1 | R7 | Local source attestation is not bound to the launched process. | `packages/mcp-server/src/config.ts:418-455` | IMPLEMENTED |
| 61 | P1 | R7 | Unresolved SHA-shaped metadata satisfies publication authorization. | `scripts/lib/release-candidate.mjs:363-396` | IMPLEMENTED |
| 62 | P2 | R4 | Read-only Moodle Forum target read marks posts as read. | `connector/extension/src/moodle-forum-post-executor.js:353-356` | IMPLEMENTED |
| 63 | P2 | R3 | Moodle identity-field labels break valid group privacy projection. | `connector/extension/src/moodle-groups-read.js:89-123` | IMPLEMENTED |
| 64 | P2 | R4 | Moodle site inventory rejects normal plugin row classes. | `connector/extension/src/moodle-site-inventory-read.js:94,283-296` | IMPLEMENTED |
| 65 | P2 | R4 | Moodle course-copy verification compares short name with full name. | `connector/extension/src/moodle-backup-executor.js:867-944` | IMPLEMENTED |
| 66 | P2 | R2 | Failed batch creation leaves an earlier outer operation live. | `packages/mcp-server/src/morrow-runtime.ts:1098-1175`; `packages/batch-engine/src/settlement.ts:489-500` | IMPLEMENTED |
| 67 | P2 | R6 | Relaunch recreates data after successful in-app removal. | `installer/shared/installer-controller.cjs:344-400` | IMPLEMENTED |
| 68 | P2 | R6 | Claude Desktop is accepted as Claude Code. | `installer/shared/assistant-app-detection.cjs:5-23` | IMPLEMENTED |
| 69 | P2 | R4 | Canvas summary tools cannot preserve valid 64-bit IDs. | `packages/mcp-server/src/canvas-course-summaries.ts:35-52` | IMPLEMENTED |
| 70 | P2 | R4 | Canvas course discovery rejects opaque next links. | `connector/extension/src/canvas-content.js:1168-1198` | IMPLEMENTED |
| 71 | P2 | R1 | Discussion-entry update cannot verify its normal collection readback. | `packages/canvas-api-catalog/src/readback-plan.ts:301-352` | IMPLEMENTED |
| 72 | P2 | R5 | Development legacy Bridge overlay sends an invalid hello key. | `integrations/morrow-legacy/extension/morrow-gateway-bridge.js:126-143` | IMPLEMENTED |
| 73 | P2 | R5 | Private Chat cancellation does not reach the Bridge request. | `packages/canvas-connector-mcp/src/runtime.ts:556-564` | IMPLEMENTED |
| 74 | P2 | R5 | Consent removal keeps stale Private Chat state. | `connector/extension/src/service-worker.js:4739-4750` | IMPLEMENTED |
| 75 | P2 | R7 | Public candidate rights evidence covers pre-transform manifests. | `scripts/lib/release-candidate.mjs:425-555,936-1038,1222-1264` | IMPLEMENTED |
| 76 | P2 | R7 | Final desktop receipt drops its source checkpoint. | `scripts/package-mcp-bundle.mjs:969-1018` | IMPLEMENTED |
| 77 | P2 | R5 | Large native MCP continuations become ordinary artifacts. | `packages/mcp-server/src/result-artifacts.ts:72-124` | IMPLEMENTED |
| 78 | P2 | R3 | Program inventory treats site-local course IDs as global. | `packages/mcp-server/src/course-inventory.ts:254-278` | IMPLEMENTED |
| 79 | P2 | R5 | Private Chat continuation state can replay the same reply. | `packages/mcp-server/src/private-chat.ts:122-169` | IMPLEMENTED |
| 80 | P2 | R8 | Local operation status tools cause unbounded provider reads. | `packages/mcp-server/src/runtime.ts:6692-6717` | IMPLEMENTED |
| 81 | P2 | R4 | Lesson Review accepts whitespace as exact quoted evidence. | `packages/mcp-server/src/lesson-review.ts:8-20` | IMPLEMENTED |
| 82 | P3 | R5 | Inventory final egress replaces the real failure with a privacy error. | `packages/mcp-server/src/runtime.ts:6865-6883` | IMPLEMENTED |

## Defects 83–94

| ID | Sev | Family | Defect | Primary source | Status |
| ---: | :---: | :---: | --- | --- | :---: |
| 83 | P1 | R2 | A settled Blackboard receipt is pruned while its signed effect grant can still be replayed. | `packages/blackboard-learn-api/src/operations/effect-receipts.ts:24-31,387-396` | IMPLEMENTED |
| 84 | P1 | R2 | Concurrent Blackboard processes replace shared effect and session files from stale whole-file caches. | `packages/blackboard-learn-api/src/operations/effect-receipts.ts:357-412`; `operations/effect-scope.ts:172-249` | IMPLEMENTED |
| 85 | P1 | R2 | A reused source operation ID returns stale verified evidence after its frozen authority changes. | `packages/operation-journal/src/effect-broker.ts:534-617` | IMPLEMENTED |
| 86 | P1 | R2 | An unconfirmed source task can finalize a batch as provider-complete. | `packages/mcp-server/src/morrow-runtime.ts:1812-1818` | IMPLEMENTED |
| 87 | P2 | R5 | Closing an upstream can leave its child process or descendants alive. | `packages/upstream-mcp/src/index.ts`; `packages/upstream-mcp/src/strict-stdio.ts` | IMPLEMENTED |
| 88 | P2 | R6 | A failed multi-file client bundle render leaves a mixed old and new bundle. | `packages/client-config/src/index.ts:1535-1564` | IMPLEMENTED |
| 89 | P2 | R6 | A process exit during the Bridge directory swap loses the only durable update phase. | `installer/shared/bridge-updates.cjs:610-811,960-1036` | IMPLEMENTED |
| 90 | P2 | R6 | Desktop update shutdown commits before its update-attempt record is durable. | `installer/shared/updates.cjs:189-243,557-639` | IMPLEMENTED |
| 91 | P2 | R6 | A newer update can overwrite the record of an earlier unverified installed update. | `installer/shared/updates.cjs:428-541,557-569` | IMPLEMENTED |
| 92 | P2 | R6 | macOS activation can create an orphan window before desktop bootstrap completes. | `installer/main.cjs:447-523,778-794` | IMPLEMENTED |
| 93 | P2 | R6 | Windows detection misses the documented native Claude Code installation directory. | `installer/shared/assistant-app-detection.cjs:31-68` | IMPLEMENTED |
| 94 | P2 | R6 | Data removal leaves a dangling Blackboard tenant that blocks reconnection. | `installer/shared/state-policy.cjs:67-99`; `installer/shared/blackboard.cjs:151-159,224-270,313-334`; `installer/shared/installer-controller.cjs:1497-1546` | IMPLEMENTED |

## Defects 95–100

| ID | Sev | Family | Defect | Primary source | Status |
| ---: | :---: | :---: | --- | --- | :---: |
| 95 | P1 | R7 | Modified installed dependency code can receive a clean-source desktop release receipt. | `scripts/package-mcp-bundle.mjs:251-291,578-631` | IMPLEMENTED |
| 96 | P2 | R7 | Windows smoke evidence can come from an installer other than the retained release artifact. | `scripts/test/desktop-windows-smoke.mjs:550-553`; `scripts/create-zero-tolerance-receipt.mjs:79-95` | IMPLEMENTED |
| 97 | P2 | R7 | Pull-request CI permits stale generated Canvas connector modules. | `.github/workflows/ci.yml:23-30`; `package.json:17-34` | IMPLEMENTED |
| 98 | P2 | R7 | Signing preflight accepts incomplete workflow wiring and rejects supported API-key notarization. | `scripts/release-signing-preflight.mjs:32-43,87-119` | IMPLEMENTED |
| 99 | P1 | R1 | Blackboard announcement create can verify from a pre-existing matching announcement. | `packages/blackboard-learn-api/src/operations/announcements.ts:712-745` | IMPLEMENTED |
| 100 | P1 | R3 | A copied Blackboard course is projected through the source course's learner roster. | `packages/blackboard-learn-api/src/operations/course-lifecycle.ts:404-429,1094-1110` | IMPLEMENTED |

## Defects 101+

| ID | Sev | Family | Defect | Primary source | Status |
| ---: | :---: | :---: | --- | --- | :---: |
| 101 | P1 | R7 | Shipped release configuration rejects its revision and digest environment templates before expansion. | `packages/mcp-server/src/config.ts:10-12,367-444` | IMPLEMENTED |
| 102 | P3 | R5 | Restart integration tests subscribe to Bridge closure after shutdown and wait forever for an event that already occurred. | `packages/mcp-server/test/batch.integration.test.ts:831,940` | IMPLEMENTED |
| 103 | P2 | R4 | Classic Quiz repair expects request-side answer keys while ordinary Canvas reads return stored `text`, `html`, `comments`, `comments_html`, and `weight` keys. | `packages/mcp-server/src/page-correction.ts:843,893-904`; `connector/extension/src/canvas-content.js:1573-1591` | IMPLEMENTED |

## Defects 104–143

| ID | Sev | Family | Defect | Primary source | Status |
| ---: | :---: | :---: | --- | --- | :---: |
| 104 | P1 | R5 | The extension reveals its bearer token and accepts commands before it authenticates the Bridge server. | `packages/bridge-protocol/src/index.ts`; `packages/bridge-loopback/src/index.ts`; `connector/extension/src/service-worker.js`; `connector/extension/popup/popup-view.js` | IMPLEMENTED |
| 105 | P2 | R5 | An in-flight approved pairing poll can restore the Bridge token after Disconnect removes it. | `connector/extension/src/service-worker.js:4426-4455,4707-4728` | IMPLEMENTED |
| 106 | P2 | R8 | Caller-forgeable Canvas resume tokens can reset the cumulative 500-page limit. | `connector/extension/src/service-worker.js`; `connector/extension/src/canvas-content.js`; `scripts/test/canvas-list-resume.test.mjs`; `scripts/test/canvas-connector-browser.mjs` | IMPLEMENTED |
| 107 | P2 | R8 | Unbounded automatic update I/O can prevent the desktop window and IPC from opening. | `installer/main.cjs`; `installer/test/contract.test.cjs` | IMPLEMENTED |
| 108 | P2 | R2 | Desktop repair and configuration mutations start without authoritative owner maintenance admission. | `installer/shared/installer-controller.cjs`; `installer/test/installer-controller.test.cjs`; assistant and adversarial desktop regressions | IMPLEMENTED |
| 109 | P3 | R6 | Background update completion does not reach the open desktop window or assistive technology. | `installer/main.cjs`; `installer/preload.cjs`; `installer/renderer/index.html`; `installer/renderer/renderer.js` | IMPLEMENTED |
| 110 | P2 | R5 | PID reuse can preserve dead runtime, proxy, maintenance, durable transaction, and Bridge-update authority as live. | `packages/gateway-core/src/process-lifetime.ts`; `packages/mcp-server/src/local-owner.ts`; `packages/mcp-server/src/local-owner-maintenance.ts`; `packages/mcp-server/src/state-lease.ts`; `packages/blackboard-learn-api/src/operations/durable-state.ts`; `installer/shared/process-lifetime.cjs`; `installer/shared/bridge-updates.cjs` | IMPLEMENTED |
| 111 | P2 | R8 | The desktop CLI runner retains unbounded output and never settles if a child ignores `SIGTERM`. | `installer/shared/installer-controller.cjs`; `installer/test/installer-controller.test.cjs` | IMPLEMENTED |
| 112 | P2 | R5 | Normal desktop quit does not wait for runtime, child, or maintenance-lease cleanup. | `installer/main.cjs`; `installer/shared/installer-controller.cjs`; `installer/test/main-lifecycle.test.cjs` | IMPLEMENTED |
| 113 | P2 | R6 | Non-atomic stale Bridge-lock reclamation can admit two update owners. | `installer/shared/bridge-updates.cjs`; `installer/test/bridge-updates.test.cjs` | IMPLEMENTED |
| 114 | P2 | R6 | Changed Bridge bytes with the same extension version never reach an existing installation. | `installer/shared/installer-controller.cjs`; `installer/shared/bridge-updates.cjs`; Bridge update and controller regressions | IMPLEMENTED |
| 115 | P2 | R7 | The packager accepts a Bridge version that the installer rejects. | `scripts/package-mcp-bundle.mjs`; `installer/shared/bridge-updates.cjs` | IMPLEMENTED |
| 116 | P2 | R7 | Packaging can seal stale ignored workspace executables under a clean source checkpoint. | `scripts/package-mcp-bundle.mjs`; `scripts/test/desktop-package-provenance.test.mjs` | IMPLEMENTED |
| 117 | P2 | R7 | macOS CI tests the ZIP but retains and uploads the untested DMG. | `.github/workflows/desktop-release.yml`; `scripts/test/desktop-release-workflow.test.mjs` | IMPLEMENTED |
| 118 | P2 | R7 | The CycloneDX SBOM uses dependency ranges and omits transitive shipped components. | `scripts/lib/release-candidate.mjs`; `scripts/test/release-gates.test.mjs` | IMPLEMENTED |
| 119 | P2 | R7 | An unsigned Windows package can inherit signing credentials while its receipt says unsigned. | `scripts/package-mcp-bundle.mjs`; `installer/electron-builder.config.cjs` | IMPLEMENTED |
| 120 | P2 | R7 | Ambient environment can select the Chrome Web Store route without evidence or receipt disclosure. | `installer/shared/bridge-delivery.cjs`; `installer/electron-builder.config.cjs`; `scripts/package-mcp-bundle.mjs` | IMPLEMENTED |
| 121 | P2 | R7 | The updater guide names a different repository from the executable feed configuration. | `installer/shared/update-feed.cjs`; `installer/electron-builder.config.cjs`; `installer/main.cjs`; `installer/UPDATES.md` | IMPLEMENTED |
| 122 | P3 | R7 | An interrupted Node runtime download permanently poisons the shared package cache. | `scripts/package-mcp-bundle.mjs`; `scripts/test/desktop-package-provenance.test.mjs` | IMPLEMENTED |
| 123 | P3 | R7 | Native smoke harnesses retain temporary application state after success and failure. | `scripts/lib/temporary-directory.mjs`; `scripts/test/desktop-mac-smoke.mjs`; `scripts/test/desktop-windows-smoke.mjs` | IMPLEMENTED |
| 124 | P1 | R2 | Contradictory tool annotations and behavior metadata can route a mutation as a read without effect admission. | `packages/gateway-core/src/catalog.ts:89,136`; `packages/mcp-server/src/runtime.ts:6999,8181` | IMPLEMENTED |
| 125 | P1 | R5 | Provider-change cancellation is dropped between the public Gateway call and the browser connector effect. | `packages/mcp-server/src/runtime.ts`; `packages/canvas-connector-mcp/src/runtime.ts`; `packages/bridge-loopback/src/index.ts`; `connector/extension/src/service-worker.js` | IMPLEMENTED |
| 126 | P2 | R8 | The no-cursor 200-record operation list makes older uncertain operations undiscoverable and undercounts health. | `packages/operation-journal/src/effect-broker.ts`; `packages/mcp-server/src/runtime.ts`; `packages/mcp-server/src/operation-tools.ts` | IMPLEMENTED |
| 127 | P2 | R3 | Private Chat's final leak scan mistakes prose after a protected learner label for an unknown ID. | `connector/extension/src/protected-request.js`; `scripts/test/private-chat.test.mjs` | IMPLEMENTED |
| 128 | P2 | R4 | Moodle's normal multiple-select names make both native Forum export readers refuse the export form. | `connector/extension/src/moodle-forum-read.js`; `connector/extension/src/moodle-forum-post-executor.js` | IMPLEMENTED |
| 129 | P1 | R1 | Successful Moodle and specialized Canvas reads cannot cross the public boundary because delivery proof assumes every browser read reports `sent: true`. | `packages/mcp-server/src/runtime.ts`; `packages/operation-journal/src/index.ts` | IMPLEMENTED |
| 130 | P1 | R1 | Outer public-read delivery authority leaks into nested binding and roster reads, so learner-token reads fail before provider dispatch. | `packages/mcp-server/src/runtime.ts` | IMPLEMENTED |
| 131 | P2 | R4 | Settings converts discovered Canvas course IDs through JavaScript numbers and rejects or changes valid 64-bit IDs. | `connector/extension/settings/settings.js`; `scripts/test/settings-page.test.mjs` | IMPLEMENTED |
| 132 | P2 | R4 | Moodle discovery exposes an empty replacement page when the course total is an exact page-size multiple. | `connector/extension/src/moodle-executor.js`; `scripts/test/moodle-browser-executor.test.mjs` | IMPLEMENTED |
| 133 | P2 | R6 | Damaged saved Blackboard state collapses to the clean not-configured state and loses its recovery path. | `installer/shared/blackboard.cjs`; `installer/shared/contract.cjs`; `installer/renderer/renderer.js`; Blackboard and renderer regressions | IMPLEMENTED |
| 134 | P2 | R8 | Twenty provider response paths could allocate complete response bodies before enforcing their byte limits. | `connector/extension/src/canvas-conversations.js`; `connector/extension/src/canvas-file-content.js`; `connector/extension/src/canvas-file-transfer.js`; `connector/extension/src/canvas-new-quiz-hot-spot.js`; `connector/extension/src/moodle-backup-executor.js`; `connector/extension/src/moodle-bbb-executor.js`; `connector/extension/src/moodle-completion-executor.js`; `connector/extension/src/moodle-course-settings-executor.js`; `connector/extension/src/moodle-enrolment-executor.js`; `connector/extension/src/moodle-forum-read.js`; `connector/extension/src/moodle-gradebook-executor.js`; `connector/extension/src/moodle-h5p-executor.js`; `connector/extension/src/moodle-lti-executor.js`; `connector/extension/src/moodle-privacy.js`; `connector/extension/src/moodle-qbank-executor.js`; `connector/extension/src/moodle-qbank-question-executor.js`; `connector/extension/src/moodle-restrictions-executor.js`; `connector/extension/src/moodle-scorm-executor.js`; `connector/extension/src/moodle-workshop-executor.js`; `packages/blackboard-learn-api/src/client.ts`; `scripts/test/browser-response-bounds.test.mjs`; `scripts/test/provider-response-body-guard.test.mjs`; direct executor and Blackboard transport regressions | IMPLEMENTED |
| 135 | P3 | R6 | Popup background connection changes update visible text without one atomic assistive-status announcement. | `connector/extension/popup/popup.html`; `connector/extension/popup/popup.js`; `connector/extension/popup/popup-view.js`; `scripts/test/popup-view.test.mjs` | IMPLEMENTED |
| 136 | P3 | R6 | A completed user-started setup step loses focus when its old action is removed by the next view. | `installer/renderer/index.html`; `installer/renderer/renderer.js`; `installer/test/renderer.test.cjs` | IMPLEMENTED |
| 137 | P2 | R3 | Final MCP egress replaces fixed privacy and capability problem identities with the generic privacy refusal. | `packages/mcp-server/src/runtime.ts`; `packages/mcp-server/test/moodle-history-egress.test.ts` | IMPLEMENTED |
| 138 | P1 | R3 | Native multi-provider audit egress applies the first connector catalog entry instead of the provider from the verified course binding. | `packages/mcp-server/src/runtime.ts`; `packages/mcp-server/test/program-scale.integration.test.ts` | IMPLEMENTED |
| 139 | P1 | R1 | Canonically duplicate source IDs let one process publish a catalog route that dispatch resolves through another process. | `packages/mcp-server/src/config.ts`; `packages/mcp-server/src/runtime.ts`; `packages/gateway-core/src/catalog.ts`; direct config, catalog, and startup regressions | IMPLEMENTED |
| 140 | P1 | R1 | A restart after verified Canvas create readback loses the provider-assigned page URL or assignment ID and permanently strands its result-bound module placement. | `packages/batch-engine/src/canvas-result-binding.ts`; `packages/batch-engine/src/recovery.ts`; `packages/operation-journal/src/effect-broker.ts`; `packages/mcp-server/src/runtime.ts`; focused recovery and integration regressions | IMPLEMENTED |
| 141 | P2 | R1 | Bridge validation changes an approved Canvas Inbox message body before dispatch. | `packages/bridge-protocol/src/index.ts`; `packages/bridge-protocol/test/protocol.test.ts`; `packages/mcp-server/test/canvas-connector.integration.test.ts` | IMPLEMENTED |
| 142 | P2 | R1 | Reconciliation treats read/write, destructive, or idempotence annotation drift as compatible and selects one source. | `packages/gateway-core/src/reconcile.ts`; `packages/gateway-core/test/reconcile.test.ts` | IMPLEMENTED |
| 143 | P2 | R5 | Loopback shutdown waits on an accepted unauthenticated WebSocket that it never closes. | `packages/bridge-loopback/src/index.ts`; `packages/bridge-loopback/test/server.test.ts` | IMPLEMENTED |
| 144 | P1 | R4 | Private Canvas planning and source schemas force course and folder IDs through unsafe JavaScript numbers. | `packages/canvas-connector-mcp/src/server.ts`; `packages/canvas-connector-mcp/test/privacy-boundary.test.ts`; `packages/mcp-server/src/canvas-conversations.ts`; `packages/mcp-server/src/canvas-file-transfer.ts`; `packages/mcp-server/src/runtime.ts`; focused unit and integration regressions | IMPLEMENTED |
| 145 | P1 | R7 | Signed desktop packaging trusts a self-declared prepared payload as its release trust root. | `installer/shared/packager-admission.cjs`; `installer/electron-builder.config.cjs`; `scripts/package-mcp-bundle.mjs`; focused packager and provenance regressions | IMPLEMENTED |
| 146 | P2 | R6 | Quit can finish before desktop bootstrap creates late resources and a window. | `installer/main.cjs:475-565,593-620,794-813`; `installer/test/main-lifecycle.test.cjs:273-407` | IMPLEMENTED |
| 147 | P2 | R2 | A damaged update-attempt record is treated as confirmed absence, so a newer download proceeds while the durable handoff owner is unknown. | `installer/shared/updates.cjs`; `installer/test/updates.test.cjs` | IMPLEMENTED |
| 148 | P2 | R6 | The desktop follows linked installer state and admits malformed assistant identities, paths, and digests as setup authority. | `installer/shared/state-policy.cjs`; `installer/shared/installer-controller.cjs`; focused state-policy, controller, and assistant-management regressions | IMPLEMENTED |
| 149 | P3 | R6 | Passive renderer redraws discard keyboard focus from replaced actions and disclosure summaries. | `installer/renderer/index.html`; `installer/renderer/renderer.js`; renderer unit and Chromium regressions | IMPLEMENTED |
| 150 | P3 | R6 | A nonterminal update reconciliation is memoized for the process and cannot finish after runtime repair. | `installer/shared/updates.cjs`; `installer/test/updates.test.cjs` | IMPLEMENTED |
| 151 | P2 | R6 | Assistant setup validates canonical launch files but stores mutable symlink paths. | `packages/client-config/src/index.ts`; `packages/client-config/test/client-config.test.ts` | IMPLEMENTED |
| 152 | P1 | R6 | Claude Desktop setup and launch checks trust mutable runtime paths without binding their bytes. | `installer/shared/claude-desktop.cjs`; `installer/test/claude-desktop.test.cjs` | IMPLEMENTED |
| 153 | P2 | R6 | Client configuration privacy is not verified after writes or unchanged setup. | `packages/client-config/src/index.ts`; `packages/client-config/test/client-config.test.ts` | IMPLEMENTED |
| 154 | P2 | R6 | Configuration rollback changes an existing user-owned project directory to Morrow's private-directory mode. | `installer/shared/runtime.cjs`; `installer/test/runtime.test.cjs` | IMPLEMENTED |
| 155 | P2 | R6 | JSON assistant removal rejects setup-supported JSONC or reserializes unrelated settings and large numeric literals. | `packages/client-config/src/index.ts`; `packages/client-config/test/client-config.test.ts`; `installer/shared/installer-controller.cjs`; `installer/test/assistant-management.test.cjs` | IMPLEMENTED |
| 156 | P2 | R6 | A confirmed assistant-file removal followed by installer-record commit failure strands contradictory configuration authority. | `installer/shared/installer-controller.cjs`; `installer/test/assistant-management.test.cjs` | IMPLEMENTED |
| 157 | P1 | R6 | Repeated Claude Desktop setup can leave an older installed launcher authoritative after replacement or removal. | `installer/shared/claude-desktop.cjs`; `installer/shared/installer-controller.cjs`; focused Claude Desktop and assistant-management regressions | IMPLEMENTED |
| 158 | P1 | R6 | Any client name and any copied Claude launcher can create the receipt used as installation proof. | `installer/shared/claude-desktop.cjs`; `installer/test/claude-desktop.test.cjs` | IMPLEMENTED |
| 159 | P1 | R5 | Course-data consent withdrawal does not revoke a Bridge connection or provider command already across an asynchronous boundary. | `connector/extension/src/service-worker.js`; `scripts/test/extension-lifecycle-authority.test.mjs` | IMPLEMENTED |
| 160 | P1 | R5 | Bridge socket closure erases active command ownership and permits a read or write to start after the owning session ends. | `connector/extension/src/service-worker.js`; `scripts/test/extension-lifecycle-authority.test.mjs` | IMPLEMENTED |
| 161 | P2 | R5 | Disconnect leaves a durable course-connection intent that a late Chrome permission grant can complete. | `connector/extension/src/service-worker.js`; `scripts/test/extension-lifecycle-authority.test.mjs` | IMPLEMENTED |
| 162 | P2 | R3 | Stateless modern local-owner clients share one result-artifact audience and can page each other's private saved results. | `packages/mcp-server/src/result-artifacts.ts`; `packages/mcp-server/src/server.ts`; `packages/mcp-server/src/local-owner.ts`; `packages/mcp-server/test/result-artifacts.test.ts`; `packages/mcp-server/test/local-owner.integration.test.ts` | IMPLEMENTED |
| 163 | P2 | R5 | Accepted partial HTTP bodies can hold the approval and local-owner servers open through shutdown. | `packages/mcp-server/src/approval-server.ts`; `packages/mcp-server/src/local-owner.ts`; `packages/mcp-server/test/approval-server-http-lifecycle.test.ts`; `packages/mcp-server/test/local-owner-lifecycle.integration.test.ts` | IMPLEMENTED |
| 164 | P2 | R5 | Approval shutdown cannot cancel one approved operation and waits for provider work that never receives its shutdown signal. | `packages/mcp-server/src/approval-server.ts`; `packages/mcp-server/src/morrow-runtime.ts`; `packages/mcp-server/test/approval-operation-shutdown.test.ts` | IMPLEMENTED |
| 165 | P2 | R5 | Shutdown cannot reach a spawned upstream until initialization finishes, and reconnect backoff is uncancellable. | `packages/upstream-mcp/src/index.ts`; `packages/upstream-mcp/test/index.test.ts`; `packages/upstream-mcp/test/fixtures/silent-upstream.mjs` | IMPLEMENTED |
| 166 | P2 | R5 | Strict stdio close leaves backpressured sends and the proxy process pending when its peer stops reading stdout. | `packages/mcp-server/src/strict-stdio.ts`; `packages/mcp-server/test/strict-stdio.test.ts`; `packages/mcp-server/test/fixtures/strict-stdio-backpressure.mjs` | IMPLEMENTED |
| 167 | P2 | R5 | An idle modern local-owner client cannot serve as the exact maintenance monitor. | `packages/mcp-server/src/local-owner.ts`; `packages/mcp-server/test/local-owner-lifecycle.integration.test.ts` | IMPLEMENTED |
| 168 | P2 | R8 | Unauthenticated loopback pairing responses have no byte limit or deadline before the extension parses their complete JSON bodies. | `connector/extension/src/service-worker.js`; `scripts/test/extension-lifecycle-authority.test.mjs`; `scripts/test/provider-response-body-guard.test.mjs` | IMPLEMENTED |
| 169 | P2 | R8 | Browser provider executors can wait forever for response headers after their operation deadline. | `connector/extension/src` provider executors excluding `service-worker.js`; `scripts/test/provider-fetch-deadline.test.mjs`; `scripts/test/provider-fetch-deadline-guard.test.mjs`; Moodle section regression | IMPLEMENTED |
| 170 | P1 | R6 | Canvas connector bearer-token state follows links, reads without a byte bound, and ignores failed privacy enforcement. | `packages/canvas-connector-mcp/src/config.ts`; `packages/canvas-connector-mcp/test/config.test.ts` | IMPLEMENTED |
| 171 | P2 | R5 | The legacy overlay ignores Bridge cancellation and lets commands outlive the socket or readiness generation that admitted them. | `integrations/morrow-legacy/extension/morrow-gateway-bridge.js`; `integrations/morrow-legacy/extension/morrow-gateway-bridge-protocol.js`; `integrations/morrow-legacy/extension/morrow-gateway-bridge-runtime.js`; `packages/legacy-bridge-mcp/src/runtime.ts`; focused overlay and runtime regressions | IMPLEMENTED |
| 172 | P1 | R3 | Real legacy bindings omit the principal, session generation, and catalog evidence required by the public source privacy boundary, so every public course call is refused. | `integrations/morrow-legacy/extension/morrow-gateway-bridge-bindings.js`; `scripts/test/legacy-bridge-overlay.test.mjs` | IMPLEMENTED |
| 173 | P2 | R7 | Copied legacy overlay modules have no build identity, so stale or partially refreshed code can claim the unchanged donor revision. | `integrations/morrow-legacy/extension/morrow-gateway-bridge*.js`; `packages/legacy-bridge-mcp/src/identity.ts`; `packages/legacy-bridge-mcp/src/runtime.ts`; overlay identity regressions | IMPLEMENTED |
| 174 | P2 | R5 | The legacy MCP entrypoint drops its stdio handle and leaves the loopback listener alive after its parent input ends. | `packages/legacy-bridge-mcp/src/index.ts`; `packages/legacy-bridge-mcp/test/entrypoint.test.ts` | IMPLEMENTED |
| 175 | P2 | R1 | The checked-in legacy federation example pins a placeholder donor revision that the exporter, installer, and runtime reject. | `morrow.upstreams.with-legacy-bridge.example.json`; `scripts/test/legacy-bridge-overlay.test.mjs` | IMPLEMENTED |
| 176 | P2 | R8 | Legacy MCP startup fully reads any catalog path before it proves a bounded regular file, so a path mistake can retain startup or allocate an oversized file. | `packages/legacy-bridge-mcp/src/config.ts`; `packages/legacy-bridge-mcp/test/config.test.ts` | IMPLEMENTED |
| 180 | P2 | R7 | The public candidate retains the connector package command but omits modules that it loads before the command can start. | `config/release-profiles.json`; `scripts/package-canvas-connector.mjs`; `scripts/package-mcp-bundle.mjs` | IMPLEMENTED |
| 181 | P1 | R7 | A caller-selected evidence policy can replace the trusted authorization keys for release receipts. | `scripts/lib/release-candidate.mjs`; `scripts/test/release-gates.test.mjs` | IMPLEMENTED |
| 182 | P1 | R7 | Uncommitted release-profile rules can select candidate bytes while the receipt still names `HEAD`. | `scripts/lib/release-candidate.mjs`; `scripts/test/release-gates.test.mjs` | IMPLEMENTED |
| 183 | P1 | R7 | Candidate conformance trusts a receipt-selected archive and its self-declared digest without reconstructing the frozen candidate. | `scripts/lib/release-candidate.mjs`; `scripts/test/release-gates.test.mjs` | IMPLEMENTED |
| 184 | P1 | R7 | Unsigned QA packaging emits production stable-update metadata even though the application reports updates disabled. | `installer/electron-builder.config.cjs`; `scripts/package-mcp-bundle.mjs`; `installer/test/electron-builder-config.test.cjs` | IMPLEMENTED |
| 185 | P2 | R7 | macOS smoke receipts can be paired with an unrelated application and omit the ZIP named by the package receipt. | `.github/workflows/desktop-release.yml`; `scripts/test/desktop-mac-smoke.mjs`; focused macOS release regressions | IMPLEMENTED |
| 186 | P2 | R7 | Failed desktop jobs upload partial evidence under the normal successful artifact names. | `.github/workflows/desktop-release.yml`; `scripts/test/desktop-release-workflow.test.mjs` | IMPLEMENTED |
| 187 | P2 | R7 | CI and desktop packaging use the moving `Node 22` selector instead of one reviewed toolchain release. | `.github/workflows/ci.yml`; `.github/workflows/desktop-release.yml`; focused workflow regressions | IMPLEMENTED |
| 188 | P1 | R7 | External evidence binds a mutable working-tree catalog even though candidate bytes come from `HEAD`. | `scripts/lib/release-candidate.mjs`; `scripts/test/release-gates.test.mjs` | IMPLEMENTED |
| 189 | P2 | R7 | A public candidate with missing source rights reports `candidateBuilt: true` and makes the packaging CLI exit successfully. | `scripts/lib/release-candidate.mjs`; `scripts/package-profile.mjs`; `scripts/test/release-gates.test.mjs` | IMPLEMENTED |
| 190 | P1 | R4 | Canvas file-transfer and Classic Quiz summary results coerce canonical 64-bit IDs through unsafe JavaScript numbers. | `connector/extension/src/canvas-file-transfer.js`; `connector/extension/src/canvas-classic-quiz-submission-read.js`; focused Canvas regressions | IMPLEMENTED |
| 191 | P1 | R7 | The two dependency lockfiles are not audited as separate trust roots, leaving a high-severity `tmp` path traversal in the installer and a moderate Vitest path traversal in the workspace. | `package.json`; `pnpm-lock.yaml`; `installer/package.json`; `installer/pnpm-lock.yaml`; `.github/dependabot.yml`; isolated dependency audits | IMPLEMENTED |
| 192 | P1 | R6 | The durable batch-manifest encryption key follows links, accepts shared access, reads without a strict bound, and ignores privacy-repair failure. | `packages/batch-engine/src/index.ts`; `packages/batch-engine/test/batch.test.ts` | IMPLEMENTED |
| 194 | P1 | R3 | The learner privacy vault trusts linked, shared, or unbounded key and ciphertext files as the authority for reversible learner identities. | `packages/gateway-core/src/private-state-file.ts`; `packages/gateway-core/src/privacy.ts`; `packages/gateway-core/test/privacy.test.ts` | IMPLEMENTED |
| 195 | P1 | R6 | Legacy Bridge reinstall preserves an existing broad mode on the local module that contains its bearer token. | `scripts/install-morrow-legacy-bridge.mjs`; `scripts/test/legacy-bridge-install.test.mjs`; `packages/gateway-core/src/private-state-file.ts` | IMPLEMENTED |
| 196 | P1 | R6 | Runtime-state leasing reads and rewrites an unbounded replaceable path, follows replacement links, ignores failed privacy hardening, and does not retain the admitted parent or lease-file identity. | `packages/mcp-server/src/state-lease.ts`; `packages/mcp-server/test/state-lease.test.ts` | IMPLEMENTED |
| 197 | P1 | R5 | A heartbeat ownership failure is caught without stopping the runtime, so the process can keep serving after it loses its exclusive state lease. | `packages/mcp-server/src/state-lease.ts`; `packages/mcp-server/src/local-owner.ts`; `packages/mcp-server/src/approval-entry.ts`; focused lease lifecycle regressions | IMPLEMENTED |
| 200 | P1 | R6 | Canvas connector bearer-token and extension-allowlist transactions are serialized only inside one Node process, so concurrent connector processes can reject or lose approved extensions. | `packages/canvas-connector-mcp/src/config.ts`; `packages/canvas-connector-mcp/test/config.test.ts`; `packages/canvas-connector-mcp/test/fixtures/config-state-race.mjs` | IMPLEMENTED |
| 205 | P1 | R2 | Separate source MCP processes load stale learner-vault maps, assign the same learner label, and replace the complete encrypted vault so one reversible identity mapping is lost. | `packages/gateway-core/src/private-state-file.ts`; `packages/gateway-core/src/privacy.ts`; `packages/gateway-core/test/learner-vault-durability.test.ts`; `packages/gateway-core/test/fixtures/learner-vault-worker.mjs` | IMPLEMENTED |
| 210 | P1 | R4 | Private Moodle enrolment-candidate routing rounds canonical course IDs above JavaScript's safe-integer bound before dispatch and on result return. | `packages/canvas-connector-mcp/src/server.ts`; `packages/canvas-connector-mcp/src/runtime.ts`; focused connector and Moodle browser regressions | IMPLEMENTED |
| 215 | P1 | R7 | Runtime publication and release admission parse linked or unbounded mutable trust files before binding the bytes to one named file identity. | `packages/mcp-server/src/exact-trust-file.ts`; `packages/mcp-server/src/config.ts`; `packages/mcp-server/src/runtime.ts`; `scripts/lib/exact-trust-file.mjs`; `scripts/lib/release-candidate.mjs`; focused Gateway and release regressions | IMPLEMENTED |
| 220 | P2 | R6 | A persistent sandbox estate follows linked or shared files, reads without a bound or exact schema, and publishes replacement state without durable readback. | `packages/mcp-server/src/sandbox-upstream.ts`; `packages/mcp-server/test/sandbox-profile.integration.test.ts` | IMPLEMENTED |
| 225 | P1 | R6 | Blackboard configuration, credentials, session generations, effect receipts, and their transaction lock use duplicate pathname checks that can race linked, multiply linked, oversized, or replaced files. | `packages/blackboard-learn-api/src/config.ts`; `packages/blackboard-learn-api/src/operations/durable-state.ts`; focused Blackboard configuration and effect-state regressions | IMPLEMENTED |
| 226 | P2 | R8 | Canvas API and browser-catalog startup reads paths completely before proving a bounded exact regular file. | `packages/canvas-api-catalog/src/index.ts`; `packages/canvas-api-catalog/test/catalog.test.ts`; `packages/canvas-connector-mcp/src/browser-catalog.ts`; `packages/canvas-connector-mcp/test/browser-catalog.test.ts` | IMPLEMENTED |
| 230 | P1 | R6 | Legacy Bridge removal follows the donor entrypoint path and deletes unverified overlay files without revision admission or rollback. | `scripts/remove-morrow-legacy-bridge.mjs`; `scripts/lib/legacy-bridge-overlay.mjs`; `scripts/lib/legacy-bridge-removal.mjs`; `scripts/test/legacy-bridge-remove.test.mjs` | IMPLEMENTED |
| 231 | P1 | R6 | Legacy Bridge install treats a worktree `.git` pointer as a directory and discovers that failure only after partially changing the donor. | `scripts/install-morrow-legacy-bridge.mjs`; `scripts/test/legacy-bridge-install.test.mjs` | IMPLEMENTED |
| 232 | P1 | R6 | Morrow creates its operation, effect, and batch SQLite authority files and their WAL sidecars with the process default access, and opens linked or shared database paths. | `packages/gateway-core/src/private-sqlite-state.ts`; `packages/operation-journal/src/index.ts`; `packages/operation-journal/src/effect-broker.ts`; `packages/batch-engine/src/index.ts`; `packages/batch-engine/src/recovery.ts`; `packages/batch-engine/src/settlement.ts`; focused private-SQLite regressions | IMPLEMENTED |
| 235 | P1 | R4 | Generated public Moodle schemas admit integer identifiers beyond JavaScript's exact range, so browser executors can round an accepted course, module, learner, or destructive target before provider access. | `scripts/sync-moodle-identifier-contract.mjs`; `connector/extension/generated/moodle-browser-catalog.json`; `packages/canvas-connector-mcp/src/browser-catalog.ts`; `packages/canvas-connector-mcp/src/runtime.ts`; focused generator, schema, and runtime regressions | IMPLEMENTED |
| 240 | P1 | R6 | The local-owner bearer descriptor is read through an unbounded replaceable pathname and published without durable exact readback; raw and canonical journal aliases can also strand every modern client before initialization. | `packages/mcp-server/src/local-owner.ts`; `packages/mcp-server/test/local-owner-lifecycle.integration.test.ts`; focused local-owner integration regressions | IMPLEMENTED |
| 241 | P1 | R6 | Local-owner maintenance endpoint and lease authority accepts replaceable pathname reads and best-effort private writes without strict schema, bounded identity, process-shared replacement, or durable exact readback. | `packages/mcp-server/src/local-owner-maintenance.ts`; `packages/mcp-server/test/local-owner-maintenance.test.ts`; focused lifecycle regressions | IMPLEMENTED |
| 245 | P1 | R5 | A premature or stale updater event can expose a desktop candidate as ready before its controller-owned download generation finishes. | `installer/shared/electron-updater-adapter.cjs`; `installer/shared/updates.cjs`; focused adapter, update, lifecycle, and adversarial regressions | IMPLEMENTED |
| 250 | P2 | R2 | A transaction reaper that exits after publishing its hard-link claim leaves every later process unable to recover the stale exact-private owner. | `packages/gateway-core/src/private-state-file.ts`; `packages/gateway-core/test/learner-vault-durability.test.ts` | IMPLEMENTED |
| 255 | P1 | R6 | Client configuration installation accepts multiply linked or path-replaced files and can modify an unrelated peer or report substituted bytes as installed. | `packages/client-config/src/index.ts`; `packages/client-config/test/client-config.test.ts` | IMPLEMENTED |
| 260 | P2 | R9 | Repeated Blackboard course buttons expose only “Remove” or “Allow Morrow” to assistive technology, so the action target is ambiguous. | `installer/renderer/renderer.js`; `installer/test/renderer.test.cjs` | IMPLEMENTED |
| 261 | P2 | R9 | Bridge course checkboxes expose only the course name, so matching names across sites or accounts have the same assistive action identity. | `connector/extension/settings/settings.js`; `scripts/test/settings-page.test.mjs` | IMPLEMENTED |
| 262 | P2 | R9 | Cancelling the Bridge's flagged-action confirmation hides the focused control and leaves keyboard focus without an actionable owner. | `connector/extension/settings/settings.js`; `scripts/test/settings-page.test.mjs` | IMPLEMENTED |
| 263 | P2 | R9 | Accepting the Bridge course-data disclosure hides the focused consent button without moving focus into the newly available connection flow. | `connector/extension/popup/popup.js`; `scripts/test/popup-page.test.mjs` | IMPLEMENTED |
| 264 | P1 | R8 | Repeated learner privacy projection opens and durably closes the encrypted vault once per protected reference and once per same-vault course scope, so valid large MCP results can consume minutes of CPU and miss their bounded response window. | `packages/gateway-core/src/privacy.ts`; `packages/gateway-core/test/privacy.test.ts`; `packages/mcp-server/src/runtime.ts`; `packages/mcp-server/test/batch.integration.test.ts` | IMPLEMENTED |
| 265 | P2 | R7 | The pull-request gate regression omits the generated Moodle contract and therefore rejects the stricter authoritative gate instead of proving it. | `scripts/test/ci-generated-artifacts.test.mjs`; `package.json` | IMPLEMENTED |
| 266 | P2 | R7 | The desktop gate regression omits the required dependency audit and therefore rejects the authoritative repository check command. | `scripts/test/desktop-gate.test.mjs`; `package.json` | IMPLEMENTED |
| 267 | P2 | R7 | The desktop documentation gate loads the real build configuration against an obsolete partial payload that cannot pass current package-graph admission. | `scripts/test/desktop-doc-claims.test.mjs`; `installer/shared/packager-admission.cjs` | IMPLEMENTED |
| 268 | P2 | R5 | The updater publishes identical lifecycle states when both controller flow and library events report the same transition. | `installer/shared/updates.cjs`; `scripts/test/desktop-update-harness.test.mjs` | IMPLEMENTED |
| 269 | P2 | R7 | The first-run state inventory points to old source lines, so its control and update-state evidence is no longer authoritative. | `docs/implementation/FIRST-RUN-STATE-INVENTORY.md`; `scripts/test/first-run-state-inventory.test.mjs` | IMPLEMENTED |
| 270 | P3 | R7 | The generated public Moodle catalog contains prose that violates the repository's release writing contract. | `connector/extension/generated/moodle-browser-catalog.json`; `scripts/test/no-em-dash.test.mjs` | IMPLEMENTED |
| 271 | P3 | R7 | The first-run inventory repeats a section heading and creates a false empty section in the evidence document. | `docs/implementation/FIRST-RUN-STATE-INVENTORY.md` | IMPLEMENTED |
| 272 | P2 | R9 | The full Bridge browser gate searches for the retired ambiguous course checkbox names and cannot inspect the exact accessible course identity shipped by the product. | `scripts/test/canvas-connector-browser.mjs`; `connector/extension/settings/settings.js` | IMPLEMENTED |
| 273 | P2 | R7 | The full Canvas browser fixture does not implement the exact pre-upload filename search required by the shipped collision guard, so reviewed file transfer stops before dispatch. | `scripts/test/canvas-connector-browser.mjs`; `connector/extension/src/canvas-file-transfer.js` | IMPLEMENTED |
| 274 | P1 | R7 | The protected `main` branch requires no status check, permits administrator bypass, and does not require review-conversation resolution. | GitHub branch-protection state for `bradenriggins/morrow:main`; `.github/workflows/ci.yml` | VERIFIED |
| 275 | P2 | R5 | The Bridge handshake hashes catalog source metadata, raw formatting, and help prose as execution identity, so a compatible documentation-only release revokes Edit permission and refuses the Bridge. | `packages/canvas-api-catalog/src/index.ts`; `packages/canvas-connector-mcp/src/browser-catalog.ts`; `connector/extension/src/catalog-compatibility.js` | IMPLEMENTED |
| 276 | P1 | R7 | Pull-request CI installs Chromium but never runs the real Bridge browser harnesses, so a merge can pass after the shipped pairing, Settings, or provider dispatch flow breaks. | `.github/workflows/ci.yml`; `scripts/test/ci-generated-artifacts.test.mjs` | IMPLEMENTED |
| 277 | P2 | R7 | The connector package check requires an untracked prebuilt ZIP and receipt, so the named check fails in every clean checkout before it can validate source. | `scripts/package-canvas-connector.mjs`; `scripts/test/canvas-connector-package.test.mjs` | IMPLEMENTED |
| 278 | P2 | R7 | The unattended Bridge maintenance proof rejects Playwright's Linux Chrome for Testing binary because it requires the macOS executable name. | `scripts/test/bridge-maintenance-cft.mjs`; `scripts/lib/playwright-managed-browser.mjs` | IMPLEMENTED |
| 279 | P2 | R7 | The extracted Item Bank conformance harness omits the production `stableJson` dependency, so a verified write becomes an internal failure only in the full Gateway gate. | `packages/mcp-server/test/quiz-bank-e2e.conformance.test.ts` | IMPLEMENTED |
| 280 | P2 | R5 | The operational catalog-digest upgrade invalidates every existing Edit permission even when its exact admitted actions remain compatible. | `connector/extension/src/edit-policy.js`; `connector/extension/src/service-worker.js`; `scripts/test/bridge-settings-contract.test.mjs` | IMPLEMENTED |
| 281 | P2 | R5 | Runtime and extension normalize accepted browser-catalog strings differently, so one accepted catalog can produce two handshake identities. | `packages/canvas-connector-mcp/src/browser-catalog.ts`; `connector/extension/src/catalog-compatibility.js`; focused digest regressions | IMPLEMENTED |
| 282 | P2 | R5 | Private Bridge commands are absent from handshake compatibility identity, so a route or argument-contract change can pair incompatible runtime and extension builds. | `packages/canvas-connector-mcp/src/browser-catalog.ts`; `packages/canvas-connector-mcp/src/runtime.ts`; `connector/extension/src/catalog-compatibility.js`; `connector/extension/src/service-worker.js` | IMPLEMENTED |
| 283 | P2 | R8 | Extension startup reads public catalogs without byte, UTF-8, depth, status, exact-shape, or embedded Canvas-seal admission before using them. | `connector/extension/src/catalog-compatibility.js`; `connector/extension/src/service-worker.js`; `packages/mcp-server/test/bridge-catalog-digest.test.ts` | IMPLEMENTED |
| 284 | P1 | R7 | Windows smoke evidence can relabel one installer as any caller-provided source commit because the workflow bypasses the sealed package receipt. | `.github/workflows/desktop-release.yml`; `scripts/lib/windows-smoke-evidence.mjs`; `scripts/test/desktop-windows-smoke.mjs`; `scripts/create-zero-tolerance-receipt.mjs` | IMPLEMENTED |
| 285 | P2 | R7 | Native desktop smoke quits before IPC, renderer load, first-state render, and window visibility, yet records startup as complete. | `installer/main.cjs`; `installer/preload.cjs`; `installer/renderer/renderer.js`; native desktop smoke harnesses | IMPLEMENTED |
| 286 | P2 | R8 | A renderer load failure leaves the cached main window hidden, so later activation reuses a permanently unusable window. | `installer/main.cjs`; `installer/test/main-lifecycle.test.cjs` | IMPLEMENTED |
| 287 | P2 | R8 | Native smoke process timeouts request termination but can retain unbounded output, descendants, pipes, and an unsettled parent promise. | `scripts/lib/owned-process.mjs`; native desktop smoke harnesses; `scripts/test/owned-process.test.mjs` | IMPLEMENTED |
| 288 | P1 | R5 | Modern local-owner cancellation is forwarded as an independent HTTP notification and cannot abort the active request it names. | `packages/mcp-server/src/local-owner.ts`; `packages/mcp-server/src/strict-stdio.ts`; focused modern-owner regressions | IMPLEMENTED |
| 289 | P2 | R5 | Modern local-owner requests create a fresh state-signing key and Private Chat ledger per exchange, so valid continuations expire before their next request. | `packages/mcp-server/src/local-owner.ts`; `packages/mcp-server/src/server.ts`; `packages/mcp-server/src/private-chat.ts`; focused continuation regressions | IMPLEMENTED |
| 290 | P2 | R8 | Chunked local-owner MCP request bodies bypass the declared 16 MiB limit and are read in full before later protocol rejection. | `packages/mcp-server/src/local-owner.ts`; focused HTTP-ingress regressions | IMPLEMENTED |
| 291 | P2 | R8 | The authoritative browser release runner retains unlimited output and can wait forever after its timeout when descendants or pipes remain open. | `scripts/run-browser-harnesses.mjs`; `scripts/lib/owned-process.mjs`; `scripts/test/release-gates.test.mjs` | IMPLEMENTED |
| 292 | P2 | R8 | Claude Desktop identity checks treat `child.kill()` as subprocess completion and can leave a signature or ancestry process and its pipes alive after returning. | `installer/shared/claude-desktop.cjs`; `installer/shared/process-lifetime.cjs`; `installer/test/process-lifetime.test.cjs` | IMPLEMENTED |
| 293 | P2 | R8 | The desktop release test owner can wait forever after its inner timeout when a test child or inherited descendant never reports `close`. | `installer/test/run-bounded-tests.cjs`; `scripts/lib/owned-process.mjs`; `scripts/test/desktop-release-workflow.test.mjs` | IMPLEMENTED |
| 294 | P1 | R4 | Provider response decoders accept malformed UTF-8 and replace invalid bytes, so corrupt Canvas, Moodle, Item Bank, or Blackboard data can become apparently valid JSON or HTML. | `connector/extension/src`; `packages/blackboard-learn-api/src/client.ts`; provider response guards and transport regressions | IMPLEMENTED |
| 295 | P2 | R8 | The generated-artifact gate fetches 145 Canvas specification documents without header or body deadlines, byte limits, strict decoding, or redirect refusal. | `scripts/generate-canvas-api-catalog.mjs`; `scripts/test/canvas-catalog-fetch.test.mjs` | IMPLEMENTED |
| 296 | P1 | R4 | Local-owner MCP and maintenance ingress decodes request bytes in UTF-8 replacement mode, so malformed wire bytes can enter JSON classification as different text. | `packages/mcp-server/src/local-owner.ts`; `packages/mcp-server/test/local-owner-modern-ingress.integration.test.ts` | IMPLEMENTED |
| 297 | P2 | R8 | The generated Claude Desktop launcher stops only its direct proxy process and can leave descendants and inherited pipes alive after Claude closes. | `installer/shared/claude-desktop.cjs`; `installer/test/claude-desktop.test.cjs` | IMPLEMENTED |
| 298 | P2 | R7 | Service-worker integration fixtures return hand-built text-only response objects, so they cannot exercise the shipped bounded byte-stream catalog admission and fail after a correct transport repair. | `scripts/test/blackboard-browser-route.test.mjs`; `scripts/test/canvas-course-connection-state.test.mjs`; consent and lifecycle fixtures | IMPLEMENTED |
| 299 | P1 | R5 | The generated Claude Desktop launcher decodes MCP server output in replacement mode, so malformed protocol bytes can be forwarded or mistaken for JSON text. | `installer/shared/claude-desktop.cjs`; `installer/test/claude-desktop.test.cjs` | IMPLEMENTED |
| 300 | P1 | R5 | The loopback Bridge accepts binary WebSocket frames as JSON protocol messages and replacement-decodes pairing request bytes. | `packages/bridge-loopback/src/index.ts`; `packages/bridge-loopback/test/server.test.ts` | IMPLEMENTED |
| 301 | P1 | R8 | Bridge startup can wait forever for packaged catalog headers, body bytes, or a cancellation promise, blocking pairing and every provider route. | `connector/extension/src/catalog-compatibility.js`; `connector/extension/src/service-worker.js`; `scripts/test/catalog-compatibility.test.mjs` | IMPLEMENTED |
| 302 | P1 | R8 | Pairing response deadlines await body cancellation, so an unsettled `cancel()` defeats the deadline and leaves connection setup hung. | `connector/extension/src/service-worker.js`; `scripts/test/extension-lifecycle-authority.test.mjs` | IMPLEMENTED |
| 303 | P1 | R7 | Exact-trust JSON readers replacement-decode malformed bytes, so Gateway configuration and publication policy can be admitted from text that is not present on disk. | `packages/mcp-server/src/exact-trust-file.ts`; `scripts/lib/exact-trust-file.mjs`; focused runtime and release regressions | IMPLEMENTED |
| 304 | P1 | R5 | Exact private-state readers replacement-decode malformed bytes, so connector bearer tokens, Blackboard application authority, and runtime identity can change before admission. | `packages/gateway-core/src/private-state-file.ts`; connector, Blackboard, and Gateway authority readers; focused malformed-byte regressions | IMPLEMENTED |
| 305 | P1 | R6 | Desktop state and sealed-manifest readers replacement-decode malformed bytes, so saved paths, credentials, installation generations, or release identity can be accepted from invented text. | `installer/shared/strict-utf8.cjs`; Desktop state, Bridge, updater, Claude, Blackboard, runtime, and packager readers; focused installer regressions | IMPLEMENTED |
| 306 | P2 | R8 | A stalled approval-page status request waits forever and permanently stops result updates. | `packages/mcp-server/src/approval-server.ts`; executed approval status-script regression | IMPLEMENTED |
| 307 | P1 | R8 | Provider response limits and error paths await stream cancellation, so a hostile response source can keep a terminal Bridge operation pending forever. | `connector/extension/src`; `scripts/test/browser-response-bounds.test.mjs`; provider response source guard | IMPLEMENTED |
| 308 | P2 | R8 | Declared oversized provider responses return without cancelling their bodies, leaving rejected network streams alive after the Bridge operation is terminal. | `connector/extension/src`; `scripts/test/browser-response-bounds.test.mjs`; provider response source guard | IMPLEMENTED |
| 309 | P2 | R8 | Provider responses rejected for status, route, context, or stream shape return without cancelling their bodies, allowing refused streams to outlive the operation. | `connector/extension/src`; `scripts/test/browser-response-bounds.test.mjs`; provider response source guard | IMPLEMENTED |
| 310 | P1 | R8 | The Desktop maintenance client has no default deadline, waits directly on response reads, replacement-decodes UTF-8, and leaves oversized or interrupted bodies uncancelled. | `packages/mcp-server/src/local-owner-maintenance.ts`; exact maintenance response regressions | IMPLEMENTED |
| 311 | P1 | R8 | Desktop runtime monitoring can wait forever for MCP initialization, status, course discovery, first read, diagnostics, or shutdown when a local peer stops settling requests. | `installer/shared/runtime-monitor.mjs:535-667`; deadline regression still required | IMPLEMENTED |
| 312 | P2 | R7 | The first-run evidence inventory cites stale source lines for 12 rendered controls after protocol and approval hardening moved their markup. | `docs/implementation/FIRST-RUN-STATE-INVENTORY.md`; `scripts/test/first-run-state-inventory.test.mjs` | VERIFIED |
| 313 | P1 | R1 | Every non-Canvas write route accepts a caller-supplied `_morrow.readback` and marks the write verified from that caller-chosen read. | `packages/mcp-server/src/runtime.ts`; `packages/mcp-server/src/server.ts`; `packages/mcp-server/test/operations.integration.test.ts` | IMPLEMENTED |
| 314 | P1 | R2 | Runtime state hardening opens and closes raw descriptors on the live SQLite database and its WAL sidecars, silently dropping the POSIX locks SQLite still believes it holds. | `packages/gateway-core/src/private-sqlite-state.ts`; `packages/mcp-server/src/state-lease.ts` | IMPLEMENTED |
| 315 | P2 | R7 | Four darwin-forced tests shell to `/bin/ls -lde` and fail on Linux, so the required `check` merge gate cannot pass. | `packages/gateway-core/src/private-file-access.ts`; `packages/gateway-core/test/private-file-access.test.ts`; `packages/mcp-server/test/local-owner-maintenance.test.ts` | IMPLEMENTED |
| 316 | P2 | R6 | A process that dies between linking its transaction release claim and unlinking the lock leaves every later acquirer unable to enter until a person deletes both names. | `packages/gateway-core/src/private-state-file.ts` | IMPLEMENTED |
| 317 | P1 | R3 | Egress redaction returns strings under status, grade, score, rows, and similar keys unchanged, without learner redaction or the sensitive-text refusal. | `packages/gateway-core/src/privacy.ts` | IMPLEMENTED |
| 318 | P2 | R8 | Request-path liveness checks spawn a synchronous child process per modern-protocol request, per reaper tick, and per owner-start poll, stalling the owner event loop. | `packages/gateway-core/src/process-lifetime.ts`; `packages/mcp-server/src/local-owner.ts` | IMPLEMENTED |
| 319 | P2 | R8 | Transaction admission requires a parsable `ps -o lstart=` answer, so a minimal container or a localised locale cannot construct the learner vault or start the gateway. | `packages/gateway-core/src/process-lifetime.ts`; `packages/gateway-core/src/private-state-file.ts` | IMPLEMENTED |
| 320 | P3 | R8 | The client-config CLI awaits MCP initialization and its tool call with no deadline, signal, or settlement race, so a stalled peer freezes the command. | `packages/client-config/src/cli.ts` | IMPLEMENTED |
| 321 | P3 | R7 | Two closure entries for defect 274 carry contradictory statuses and nothing fails on a duplicated closure heading. | `docs/implementation/DEFECT-ERADICATION-LEDGER.md` | IMPLEMENTED |
| 322 | P3 | R7 | Fifty ledger identifiers have no row and no recorded disposition, so the numbering cannot be audited end to end. | `docs/implementation/DEFECT-ERADICATION-LEDGER.md` | IMPLEMENTED |
| 323 | P3 | R7 | The first-run inventory cites lines that only contain a control name as an identifier substring, and the guard accepts any substring match. | `docs/implementation/FIRST-RUN-STATE-INVENTORY.md`; `scripts/test/first-run-state-inventory.test.mjs` | IMPLEMENTED |
| 324 | P3 | R7 | Three provider response source guards test text windows, so a renamed helper, a moved reader, or a differently spelled refusal keeps the forbidden behaviour while the guards stay green. | `scripts/test/provider-response-body-guard.test.mjs` | IMPLEMENTED |
| 325 | P3 | R7 | The defect 264 regressions assert wall-clock bounds instead of the one-snapshot invariant, so they can pass while the defect recurs and flake under load. | `packages/gateway-core/test/privacy.test.ts` | IMPLEMENTED |
| 326 | P3 | R6 | The Canvas connector carries a second state-transaction lock implementation whose release path differs from the shared primitive. | `packages/canvas-connector-mcp/src/config.ts` | IMPLEMENTED |
| 327 | P2 | R8 | Egress and projection tokenize every learner record and resolve every learner token through its own durable vault transaction, although the prepared snapshot already holds each label. | `packages/gateway-core/src/privacy.ts`; `packages/gateway-core/test/privacy.test.ts` | IMPLEMENTED |
| 328 | P2 | R8 | Thirty provider refusal paths in 17 Bridge source files return or throw with a fetched body still live, because the response is handed to a reading helper rather than read where it is refused. | `connector/extension/src`; `scripts/test/provider-response-body-guard.test.mjs` | IMPLEMENTED |
| 329 | P2 | R2 | The exact private file reader compares ctime across its own read, so a kernel that refines a freshly written inode's ctime after it is queried refuses every fresh readback, and the durable Blackboard session, effect, and learner vault records become unusable. | `packages/gateway-core/src/private-state-file.ts`; `packages/gateway-core/test/private-state-file.test.ts` | IMPLEMENTED |

## Identifier accounting

Every identifier from 1 through the highest row is either a ledger row or listed here, so the numbering is auditable end to end. `scripts/test/defect-ledger.test.mjs` fails when an identifier has neither a row nor an entry here, has both, or when a row or closure heading is duplicated.

| Identifiers | Disposition |
| --- | --- |
| 177–179, 193, 198–199, 201–204, 206–209, 211–214, 216–219, 221–224, 227–229, 233–234, 236–239, 242–244, 246–249, 251–254, 256–259 | Never assigned. From identifier 200 the discovery waves reserved candidate blocks of five (200, 205, 210, and so on) and only validated candidates received rows; identifiers 177–179, 193, and 198–199 were skipped the same way in the preceding wave. No row, closure entry, or merge note ever used these identifiers. Every row first appeared in commit `267e7ec`, so git history holds no further evidence. |

## Continuing work

Fresh discovery remains active after each repair wave. Every validated defect receives the next ledger ID.

- Continue adversarial discovery across every product and release boundary after the current broad gates pass.

## Evidence and closure log

### 312: current first-run control evidence

- Root cause: source hardening moved the Chrome pairing and approval-page markup, but the hand-maintained control inventory retained the prior line references. The repository gate therefore could not prove that 12 named controls still existed at the cited source locations.
- Repair: the inventory now cites the current rendered source line for each Chrome pairing and approval/result-page control.
- Regression: the inventory contract resolves every named control against the exact cited line and checks every cited file and line boundary.
- Focused verification: all 11 first-run inventory tests passed after the correction.
- Integrated verification: the clean `pnpm check` rerun passed with all 879 repository script tests settled as 878 passes and the one expected platform skip.

### 311: unbounded Desktop runtime monitor MCP operations

- Verified defect: initialization, health, course binding discovery, first safe read, diagnostic tool listing, diagnostic resource reading, client close, and transport close directly await MCP promises with no caller signal, owned deadline, or outer settlement race.
- User effect: a local owner or upstream that accepts the connection and then stops settling one request can freeze Desktop startup, refresh, diagnostic capture, first-read completion, or shutdown indefinitely.
- Required repair: one reusable Desktop MCP operation boundary must own explicit per-operation deadlines, pass its signal into every SDK request that supports cancellation, race settlement even when a peer ignores that signal, close the exact client and transport generation, and leave the monitor reconnectable. Shutdown must reclaim the spawned process tree within a fixed bound.
- Required regression: use a fixture that completes initialization and then selectively stalls each MCP operation. Every public monitor method must settle within its contract, report the fixed unavailable state, close the stalled generation, reclaim the child process, and reconnect to a healthy replacement. Add a source guard so a direct unbounded SDK request cannot return.
- Repair: the monitor holds one connected generation (client, transport, child process) and runs every MCP operation through `operate`, which owns a per-operation deadline, passes its signal and timeout to the SDK, races settlement itself, and on any failure closes exactly that generation: client and transport close within a bound and the child is reclaimed with SIGTERM then SIGKILL. Initialization, health, binding discovery, first read, and both diagnostic reads use it; shutdown closes the current generation the same way.
- Regression: a fixture that stalls initialize, health, binding discovery, the first read, the diagnostic resource read, and one that freezes and ignores SIGTERM: every public monitor method settles within its bound, reports the fixed unavailable state, reclaims that generation's child, and a healthy fixture reconnects afterwards. A syntax-tree guard requires every SDK request in the monitor to run inside `operate` with its options and every close to run inside `settleWithin`.
- Process tree: the diagnostic launcher the monitor starts in trace mode forwards SIGTERM to the gateway it spawned and escalates to SIGKILL after 500 ms, so reclaiming the launcher ends the whole generation. The stall regression records fixture pids in a dedicated log and treats a pid this user cannot signal as not a monitor child.
- Status: `IMPLEMENTED`.

### 274: enforced GitHub merge protection

- Root cause: the repository had a pull-request review rule but no required status check. Administrators could bypass protection, and unresolved review conversations did not block a merge.
- Repair: `main` now requires the exact successful GitHub Actions check identity `check` from app ID `15368`, requires the branch to be current before merge, enforces protection for administrators, preserves one approving review with stale-review dismissal, and requires every review conversation to be resolved. Force pushes and branch deletion remain disabled.
- Authoritative readback: GitHub returned `strict: true`, required check `check` with app ID `15368`, `enforce_admins: true`, `required_conversation_resolution: true`, one required approval, stale-review dismissal enabled, force pushes disabled, and deletion disabled.
- Status: `VERIFIED` against the live `bradenriggins/morrow:main` branch-protection resource on 2026-09-13.

### 310: bounded strict Desktop maintenance client

- Root cause: the authenticated maintenance client passed an optional caller signal to `fetch()` but owned no deadline. It then awaited each response-body read directly, returned from overflow without cancellation, and converted private control bytes with replacement-mode UTF-8. A stalled owner could freeze Desktop maintenance, and malformed Bridge status bytes could become accepted U+FFFD text.
- Repair: every maintenance exchange now owns a 60-second header-and-body deadline combined with any caller signal. Header and reader settlement race that signal. Every incomplete, oversized, invalid, or interrupted body is cancelled without waiting. The 8 KiB bound remains exact, and admitted bytes use the shared fatal UTF-8 decoder before JSON classification.
- Regression: a malformed Bridge status result containing byte `0xff` was accepted before repair with `note: "U+FFFD"`; it is now refused. A stream one byte over 8 KiB and a reader that never settles both produce the fixed invalid-response error and call cancellation exactly once, even when cancellation itself never settles.
- Focused verification: the Gateway build passed. All 14 local-owner maintenance tests passed. The scoped repository diff check passed.
- Remaining gate: the complete Gateway, installer, and native Desktop maintenance gates must pass after integration.

### 309: cancellation on pre-reader response refusal

- Root cause: 35 pre-reader validation branches in 27 Bridge source files combined response status, exact route, live context, body shape, and decoder admission in one early return. They did not cancel a body that was already available, so an error response or rejected route could retain its network stream after Morrow returned.
- Repair: every such refusal now starts best-effort body cancellation before returning or throwing. A missing or malformed body remains safe because cancellation is optional and cannot replace the fixed operation result.
- Regression: an exact Canvas aggregate executor receives a 503 response with a live body. Before repair it returned its fixed error with zero cancellation calls. It now returns the same error and cancels the body exactly once. The source guard requires cancellation inside every pre-reader provider response rejection.
- Focused verification: all 11 response-boundary and provider source-guard tests passed. The scoped repository diff check passed.
- Remaining gate: the complete script and real Chrome for Testing campaigns must pass after integration.

### 308: cancellation on declared response refusal

- Root cause: 42 header-limit branches in 32 Bridge source files treated `Content-Length` as a parsing shortcut. They returned before acquiring a reader and did not cancel the response body, so a provider could keep the refused network stream alive after Morrow had produced its terminal result.
- Repair: every declared-byte refusal now starts best-effort body cancellation without waiting for the provider. This covers Canvas, Moodle, Item Bank, packaged catalogs, file transfer, service-worker downloads, and loopback pairing responses.
- Regression: an exact Canvas aggregate executor receives a response whose declared length is one byte over 2 MiB. It returns its incomplete result and calls body cancellation exactly once. The source guard scans every provider header-limit boundary and requires cancellation before reader acquisition.
- Focused verification: all 9 response-boundary and provider source-guard tests passed. The scoped repository diff check passed.
- Remaining gate: the complete script and real Chrome for Testing campaigns must pass after integration.

### 307: cancellation-independent provider settlement

- Root cause: 82 response termination paths in 35 Bridge source files awaited `ReadableStreamDefaultReader.cancel()`. Stream cancellation runs provider-controlled source cleanup and may never settle, so an overflow or decode failure could defeat Morrow's byte and time bounds after the terminal condition was already known.
- Repair: every provider reader now initiates cancellation, observes any rejected cancellation promise, and returns or throws without waiting. The result identity and deadline no longer depend on provider cleanup.
- Regression: a concrete Moodle group reader receives exactly 2,000,000 bytes and then one extra byte from a reader whose `cancel()` promise never settles. The pre-repair execution remained pending past 100 milliseconds. The repaired execution returns the exact incomplete result in about one millisecond. A source guard forbids awaited cancellation across all provider readers.
- Focused verification: all 9 response-boundary and provider source-guard tests passed. The scoped repository diff check passed.
- Remaining gate: the complete script and real Chrome for Testing campaigns must pass after integration.

### 306: bounded recoverable approval status polling

- Root cause: the review page awaited an unbounded `fetch()` and response-body parse. One stalled loopback response retained that promise forever. A transient failure also ended polling permanently.
- Repair: every status read now owns a five-second abort controller across headers and body, uses fixed same-origin JSON request policy, clears its deadline, and schedules either the normal one-second poll or a five-second recovery poll.
- Regression: the test executes the exact JavaScript served by the approval server against a fetch promise that settles only when its signal aborts. It proves the five-second abort runs, the visible status changes, the deadline is cleared, and a recovery read is scheduled.
- Focused verification: the Gateway build passed. All 12 approval-page copy, HTTP lifecycle, shutdown, deadline, and recovery tests passed.
- Remaining gate: the complete Gateway and current browser gates must pass after integration.

### 305: one strict Desktop trust-byte boundary

- Root cause: Desktop independently converted private state, Bridge state, Claude setup and receipts, Blackboard configuration and credentials, updater attempts, sealed runtime manifests, and packager evidence with replacement-mode UTF-8. Free-form path and credential fields could remain schema-valid after an invalid byte became U+FFFD.
- Repair: one shared Desktop decoder now requires fatal UTF-8 and owns JSON conversion for installer records, recovery records, Blackboard private state, updater attempts, runtime manifests, Bridge manifests and transactions, Claude setup and receipts, and packager admission. The generated Claude launcher carries the equivalent boundary because it runs outside the installed shared-module tree.
- Regression: a real installer record places byte `0xff` inside an otherwise valid absolute materials path and must fail before state admission. Direct shared-boundary tests prove malformed bytes never become replacement characters and valid Unicode remains exact.
- Focused verification: all 169 affected Desktop state, Blackboard, Bridge update, Claude, updater, runtime, packager, controller, and shared-decoder tests passed. All changed CJS files passed syntax validation.
- Remaining gate: the complete bounded installer suite, packaging checks, and native installed Desktop flows must pass after integration.

### 304: one strict exact-private-state byte boundary

- Root cause: private-state readers bounded files and proved their identity, then many callers replacement-decoded those admitted bytes. The Canvas connector accepted an arbitrary 32-to-512-character token, so a malformed byte inside that token remained valid authentication state. Blackboard application keys and secrets and selected runtime metadata had the same primitive weakness.
- Repair: Gateway Core now exports one fatal UTF-8 decoder for exact authority bytes. Transaction ownership, learner-vault state, connector state and locks, Blackboard configuration, local-owner descriptors, maintenance leases, runtime leases, packaged runtime identity, and catalog truth use it before parsing or validation.
- Regression: the direct pre-repair reproduction loaded a private connector file containing byte `0xff` and returned a 49-character bearer token containing U+FFFD. The repaired connector refuses it. Separate Blackboard and packaged-runtime fixtures prove malformed application authority and ignored manifest text cannot be admitted, while valid saved state remains unchanged.
- Focused verification: Gateway Core built and passed all 124 tests. Canvas Connector built and passed all 10 configuration tests. Blackboard built and passed all 11 configuration tests. Gateway built and passed all 30 owner, maintenance, lease, and runtime tests.
- Remaining gate: the complete repository, browser, and native Desktop gates must pass after integration.

### 303: strict exact-trust JSON decoding

- Root cause: both exact-trust file implementations proved path identity and bounded the file, then converted its bytes with UTF-8 replacement decoding before JSON parsing. A malformed byte inside an otherwise valid JSON string became U+FFFD and could enter Gateway configuration or release-policy validation as text that was never stored.
- Repair: both runtime and release implementations now decode admitted bytes with fatal UTF-8 before JSON parsing. The error names the trust document, and the existing optional BOM compatibility remains intact.
- Regression: the runtime and release tests write a valid JSON object with byte `0xff` inside one string and require refusal before parsing. Separate fixtures prove a valid UTF-8 BOM document still parses.
- Focused verification: the Gateway build passed. All 18 exact-trust, Gateway configuration, and public-profile configuration tests passed. Both direct release regressions and all 17 adjacent release-gate tests passed. The scoped diff check passed.
- Remaining gate: the complete repository and packaging gates must pass after integration.

### 302: pairing settlement independent of response cancellation

- Root cause: the pairing reader raced body reads against its abort signal, then awaited `reader.cancel()` in both overflow and abort cleanup. The response source therefore controlled whether Morrow's own deadline could settle.
- Repair: pairing cancellation is now best-effort and never part of terminal settlement. Cleanup removes the abort listener and releases the reader lock without allowing either operation to replace the exact timeout or size result.
- Regression: a real response body never produces a byte and returns a cancellation promise that never settles. Pairing still returns `bridge_pairing_response_timeout`, removes pending state, and completes inside 500 milliseconds under the shortened test deadline.
- Focused verification: all 12 lifecycle, cancellation, pairing-bound, and exact-schema tests passed.
- Remaining gate: the complete script and real browser gates must pass after integration.

### 301: bounded packaged-catalog transport

- Root cause: service-worker startup called `fetch()` before its bounded reader and supplied no abort signal. The reader also awaited each body read and cancellation without a deadline. A stalled packaged response could retain catalog initialization, pairing, and every provider route forever.
- Repair: one catalog transport now owns the complete header-and-body lifetime. It applies a ten-second abort signal, fixed request policy, streamed byte limit, strict UTF-8, JSON depth admission, nonblocking cancellation, and final listener and timer cleanup.
- Regression: direct tests use a fetch that never returns headers and a body that never yields bytes whose cancellation also never settles. Both operations abort and reject inside their bounded deadline. Fragmented valid JSON remains exact. Full-flow service-worker fixtures traverse the same transport.
- Focused verification: both catalog transport tests and all 23 adjacent lifecycle, consent, connection-state, and provider-route tests passed. Source syntax passed.
- Remaining gate: the complete script and real Chrome for Testing gates must pass after integration.

### 300: text-only loopback Bridge ingress

- Root cause: the loopback WebSocket message handler ignored the `isBinary` frame flag and converted every raw payload through UTF-8 replacement decoding. A binary frame containing valid authentication JSON entered the text protocol. Pairing HTTP bodies used the same replacement behavior.
- Repair: the Bridge now refuses every binary frame before parsing and strictly decodes all raw WebSocket and pairing HTTP bytes. Malformed pairing bytes stop before identity classification.
- Regression: a real WebSocket sends a binary buffer containing a complete valid authentication message and receives close code 4400 with `invalid_message`. A real pairing status request with byte `0xff` returns the exact 400 invalid-request result instead of an identity result.
- Focused verification: the Bridge Loopback build and all 25 package tests passed.
- Remaining gate: the integrated Gateway and real browser campaigns must pass after integration.

### 299: strict Claude Desktop protocol decoding

- Root cause: the generated launcher decoded the MCP server stream through a replacement-mode text decoder. Invalid byte sequences could therefore be forwarded to Claude and parsed from text that the server did not send.
- Repair: the launcher now owns one streaming fatal UTF-8 decoder. It preserves valid fragmented Unicode, validates terminal decoder state, clears any receipt on invalid bytes, and enters the bounded process-tree shutdown path before any connection can be recorded.
- Regression: a real generated bundle runs a server that inserts byte `0xff` into its initialize response. The launcher exits, writes no connection receipt, and the normal fragmented-Unicode handshake remains valid.
- Focused verification: all 27 Claude Desktop and shared process-lifetime tests passed.
- Remaining gate: the integrated installer gate and a native installed Claude Desktop connection must pass before this row becomes `VERIFIED`.

### 298: byte-faithful service-worker integration fixtures

- Root cause: four integration fixtures modeled `fetch()` responses as objects with `text()` and `json()` methods. The shipped service worker reads and bounds the `ReadableStream` bytes, so those fixtures neither represented the browser contract nor exercised catalog byte admission.
- Repair: each affected fixture now returns a real `Response` with a JSON content type and body stream. The Hot Spot worker harness also obtains `stableJson` from the production compatibility module after that helper moved out of the service worker.
- Regression: the same full-flow tests now traverse the production streamed-body boundary for Canvas, Moodle, Blackboard routing, consent fencing, connection-state migration, pairing limits, and Hot Spot verification.
- Focused verification: the combined affected integration run passed all 51 tests.
- Remaining gate: the complete script and real browser gates must pass before this row becomes `VERIFIED`.

### 297: generated Claude Desktop process-tree ownership

- Root cause: the generated launcher asked only the direct proxy child to stop, waited two seconds, then called `child.kill()` once. It did not own descendants, escalate termination, release inherited pipes, or guarantee final settlement.
- Repair: the launcher creates a POSIX process group or uses Windows tree termination, closes standard input first, then applies graceful and forced tree termination at bounded deadlines. Final settlement removes pipes, destroys streams, clears timers, and exits even when no child close event arrives.
- Regression: a real generated bundle starts a proxy that ignores termination and owns a descendant that also ignores termination. Closing the launcher input stops both processes and the launcher inside five seconds.
- Focused verification: all 27 Claude Desktop and shared process-lifetime tests passed, including malformed protocol bytes and the stubborn process tree.
- Remaining gate: execute the generated launcher lifecycle on native Windows and an installed Claude Desktop build before this row becomes `VERIFIED`.

### 296: strict local-owner request decoding

- Root cause: local-owner bodies were converted through `Request.text()` or `Buffer.toString("utf8")`. Both replace malformed byte sequences instead of proving the bytes are UTF-8, so protocol and maintenance classification could operate on text the peer did not send.
- Repair: the bounded MCP body reader validates every streamed fragment and the terminal decoder state with fatal UTF-8 before it constructs a web request. The maintenance reader applies the same strict decode to its bounded bytes. Malformed MCP bytes receive one fixed 400 response and cannot reach protocol classification.
- Regression: a real authenticated local proxy sends byte `0xff` as an application/JSON body. The owner returns the exact `local_owner_message_invalid_utf8` problem, remains healthy, and serves a later MCP health request.
- Focused verification: the Gateway build and all 5 modern local-owner ingress tests passed. The scoped syntax and repository diff checks passed.
- Remaining gate: the integrated repository and native desktop Bridge checks must pass before this row becomes `VERIFIED`.

### 295: bounded Canvas specification generation

- Root cause: every generated-artifact check used direct `fetch()` followed by `response.json()`. A stalled response could retain the gate forever, a large body could allocate without limit, invalid UTF-8 used replacement decoding, and redirects could change the documentation authority.
- Repair: one generator transport now owns a 30-second header-and-body deadline, aborts the request, refuses redirects and non-JSON responses, enforces declared and streamed 8 MiB limits, decodes fatal UTF-8, and parses only the bounded bytes.
- Regression: focused tests accept fragmented valid JSON, reject malformed UTF-8, reject declared and streamed overflow, prove the exact request policy, and settle a fetch that never returns headers inside its test deadline.
- Focused verification: all 3 focused transport tests passed. The authoritative Canvas catalog check fetched and reproduced 1,137 current operations through the repaired transport, then the Canvas readback artifact check passed. Source and test syntax and the repository diff check passed.
- Remaining gate: the complete integrated repository check must pass before this row becomes `VERIFIED`.

### 294: strict provider response decoding

- Root cause: 59 extension response readers and the Blackboard transport used UTF-8 replacement decoding. Invalid bytes became U+FFFD before JSON parsing or HTML inspection, allowing corrupted provider content and identifiers to continue through read, planning, dispatch-state, or verification paths.
- Repair: every extension byte-to-text boundary and the Blackboard transport now select UTF-8 with `fatal: true`. Malformed Blackboard bytes cancel the body and return the exact `blackboard_response_invalid` result while preserving dispatch state. Extension operations use their existing unreadable, incomplete, or uncertain failure path.
- Regression: an executed Canvas profile response contains an invalid byte inside otherwise valid JSON and stops before the next request. Separate Blackboard read and write responses contain malformed bytes and prove body cancellation, stable error identity, and retained dispatch state. A repository guard requires strict decoding at every current and future provider `TextDecoder` site.
- Focused verification: all 19 Blackboard transport tests and both provider response guards passed. Every extension decoder passed syntax validation.
- Remaining gate: run the complete provider executor and real browser campaigns after integration.

### 293: bounded desktop release test ownership

- Root cause: the desktop release test runner sent one final signal at its time limit, then waited only for `close`. An unresponsive process, retained descendant, or inherited handle could keep the release job alive until the much wider workflow deadline.
- Repair: every per-file and full-suite run now uses the shared process owner. It streams test output without retaining it, owns the complete platform process tree, escalates termination, releases pipes and listeners, and settles after a fixed final deadline.
- Regression: workflow contract coverage requires the shared owner and refuses a return to direct `spawn` or `spawnSync` ownership. The shared process-owner tests prove real descendant termination and synthetic settlement without `close`.
- Focused verification: all 11 desktop release workflow tests and all 4 shared process-owner tests passed. Source syntax and the repository diff check passed.
- Remaining gate: run both bounded desktop test modes on native Windows.

### 292: owned Claude Desktop identity commands

- Root cause: Claude Desktop signature and ancestry checks used a private timeout helper that resolved immediately after `child.kill()`. It did not own descendants, escalate termination, release pipes and listeners, or wait for final settlement.
- Repair: signature, process ancestry, and Authenticode reads now use the shared desktop process-lifetime owner. It bounds combined diagnostic output, owns the POSIX process group or Windows process tree, escalates termination, destroys pipes, removes listeners, and settles after a fixed final deadline.
- Regression: a simulated child that never emits `close` proves graceful and forced termination, pipe destruction, listener removal, unreferencing, and bounded settlement. A real child proves combined standard and diagnostic output remains available to signature inspection.
- Focused verification: all 25 Claude Desktop and shared process-lifetime tests passed. Source syntax and the repository diff check passed.
- Remaining gate: execute Claude Desktop process verification on native Windows and macOS application installations.

### 291: bounded browser harness ownership

- Root cause: the browser release runner owned a timer but not the complete process tree, output streams, or final settlement. It accumulated every output chunk in memory and waited only for `close`, even after sending termination signals.
- Repair: the runner now uses the shared process owner. Every harness owns a POSIX process group or Windows process tree, escalates termination, destroys retained pipes, and settles after a fixed final deadline. The evidence log is written incrementally with a 4 MiB bound. A run that exceeds that bound fails instead of publishing incomplete passing evidence.
- Regression: the shared owner proves bounded output, process-tree escalation, and final settlement without `close`. The release-gate regression proves the exact written log digest and refuses a successful child whose evidence exceeds the bound.
- Focused verification: all 4 shared process-owner tests and all 21 release-gate tests passed. Source syntax and the repository diff check passed.
- Remaining gate: run the complete real browser gate after integration.

### 290: bounded local-owner message bodies

- Root cause: the local owner trusted only `Content-Length`, then converted the raw Node request into an unbounded web stream. A client using chunked transfer could send unlimited bytes before the SDK attempted JSON or protocol validation.
- Repair: one owner-side body reader counts the bytes that actually arrive, stops at the exact 16 MiB limit, and passes only the bounded buffer to protocol classification. Declared overflow is refused before body upload. Streamed overflow pauses intake, flushes the exact 413 problem, and then closes the connection without damaging the owner.
- Regression: a real authenticated proxy sends both an oversized declared body without uploading it and a chunked body one byte above the limit. Both receive the exact 413 problem, and the same proxy completes a later health call.
- Focused verification: the Gateway build and all 5 modern local-owner ingress tests passed. All 5 broader local-owner integration tests passed. Fixture syntax and the repository diff check passed.
- Remaining gate: the integrated repository and native desktop Bridge checks must pass before this row becomes `VERIFIED`.

### 289: proxy-lifetime continuation authority

- Root cause: modern HTTP serving creates a new MCP server for every request. The default server factory also created a new request-state signing key and a new continuation replay ledger each time. A Private Chat continuation therefore could not verify on the next request, and replay claims did not survive one exchange.
- Repair: the owner records one signing key and one bounded Private Chat continuation ledger for the exact proxy process and workspace lifetime. Every modern request from that presence receives the same objects. Process-lifetime reap and owner shutdown clear the ledger and overwrite the key.
- Regression: one real modern proxy starts Private Chat and successfully submits its signed continuation on its next request. A second proxy cannot use that state. Reuse of the accepted continuation is refused, and the fixture records only the two intended protected exchanges.
- Focused verification: the Gateway build and all 5 modern local-owner ingress tests passed. The combined local-owner, Private Chat, and strict-stdio campaign passed 17 supporting tests. The repository diff check passed.
- Remaining gate: the integrated repository and native assistant connection checks must pass before this row becomes `VERIFIED`.

### 288: exact modern request cancellation ownership

- Root cause: the stdio-to-HTTP proxy treated each cancellation notification as a new HTTP exchange. The active modern request used a different stream, so the owner never received cancellation through that request's abort signal. Initial cancellation tracking also ended when an SSE response opened, before its streamed request ended.
- Repair: the proxy tracks each active modern request by its type-preserving JSON-RPC ID and owns one AbortController through the complete JSON or SSE exchange. A matching cancellation removes and aborts only that request. Terminal responses and stream completion settle the entry. Proxy shutdown aborts and clears every remaining controller, and the active set is capped at 64.
- Regression: two real modern calls run together; cancelling one aborts its upstream operation while the other completes, and the proxy stays healthy. A second case opens an SSE progress stream, cancels after its first progress event, proves the upstream abort, and proves the stream cannot lose cancellation ownership when its headers arrive.
- Focused verification: the Gateway build and all 5 modern local-owner ingress tests passed. The combined local-owner, Private Chat, and strict-stdio campaign passed 17 supporting tests. The repository diff check passed.
- Remaining gate: the integrated repository and native assistant connection checks must pass before this row becomes `VERIFIED`.

### 287: bounded native smoke process ownership

- Root cause: each platform harness accumulated every output chunk and treated `child.kill()` as completion. A child that ignored that signal, retained descendants, or kept a pipe open could exceed the evidence memory bound and leave the harness promise unsettled.
- Repair: both harnesses use one process owner. It retains at most 128 KiB per output stream while reading, owns a POSIX process group or Windows process tree, escalates from graceful termination to forced termination, tears down pipes and listeners, unreferences the child, and settles after a final fixed deadline.
- Regression: real POSIX coverage proves that an uncooperative parent and descendant both exit after escalation. Unit coverage proves the Windows `taskkill /T` and `/F` sequence, output truncation while streaming, and settlement when a child never emits `close`.
- Focused verification: all 4 process-owner tests and the combined 66 native-smoke, receipt, workflow, and process-owner tests passed. The complete installer suite passed 379 tests with one expected native-Windows ACL skip. Source syntax and `git diff --check` passed.
- Remaining gate: native Windows must execute the revised process owner during the retained NSIS smoke.

### 286: recoverable renderer-load failure

- Root cause: the main process cached a hidden `BrowserWindow` before `loadFile()` completed. A rejected or stalled load left that window alive, so activation found and reused it instead of creating a working surface.
- Repair: renderer load now has a fixed 15-second owner. The window becomes visible only after load succeeds. Failure or timeout destroys the failed window, clears the cache, and shows one fixed recovery message without exposing the internal error. A later activation creates a fresh window.
- Regression: the real lifecycle test rejects the first load, proves the hidden window is destroyed and the private error is absent, then activates Morrow and proves a second window loads the canonical renderer and becomes visible.
- Focused verification: all 12 lifecycle tests and all 56 combined lifecycle, IPC-contract, and renderer tests passed. The complete installer suite passed 379 tests with one expected native-Windows ACL skip.
- Remaining gate: inspect this recovery on a native packaged desktop build.

### 285: real renderer startup proof

- Root cause: the native harness launched only `--morrow-smoke-receipt`. That diagnostic prepared the runtime, wrote a receipt, and quit before IPC registration or window creation, while its harness labeled the run `startupCompleted`.
- Repair: both native harnesses now run a second normal application launch. The real renderer completes its first `installer:get-state`, renders the result, sends a trusted acknowledgment through preload, and receives no smoke receipt until the loaded window is visibly open. Diagnostic and renderer completion are recorded separately.
- Regression: the real main-process test proves that early renderer acknowledgment, state delivery without acknowledgment, and hidden-window state cannot complete the receipt. Renderer and preload tests prove the shipped renderer acknowledges only after its first refresh and that main owns the exact channel.
- Focused verification: all 56 lifecycle, IPC-contract, and renderer tests passed. The combined 66 platform-harness, workflow, process-owner, and receipt tests passed. The complete installer suite passed 379 tests with one expected native-Windows ACL skip.
- Remaining gate: execute and inspect the new renderer launch from retained macOS and Windows package artifacts.

### 284: package-bound Windows source identity

- Root cause: the Windows workflow prepared a payload, invoked electron-builder directly, and passed `GITHUB_SHA` to the smoke harness afterward. The same EXE and digest could therefore receive valid-looking smoke bindings for two different caller-provided commits.
- Repair: Windows now packages only through the release orchestrator and retains its package receipt beside the exact EXE. Smoke admission independently requires the receipt's clean source, `win32-x64` release graph, unsigned private-QA signing state, absent Authenticode table, exact artifact name, and exact EXE digest. After installing that EXE, the harness reads the bounded identity-stable `app.asar` and requires its embedded source and release-graph digest to match the receipt. Its binding retains the receipt digest and release-graph digest. Zero-tolerance validation rebuilds that binding from the retained receipt and artifact.
- Regression: one retained EXE and receipt bind to their recorded source, while changing the requested source is refused. A forged external source or release-graph value is also refused by the metadata embedded in the installed application. Workflow tests require the orchestrator, retained receipt, and receipt-bearing smoke command, and forbid the former direct electron-builder path.
- Focused verification: all 43 Windows contract, workflow, and zero-tolerance tests passed. The wider 66-test desktop evidence group passed. Source syntax and `git diff --check` passed.
- Remaining gate: dispatch the native Windows workflow and ingest its new receipt set before accepting the platform exclusion.

### 283: bounded exact extension catalog admission

- Root cause: extension startup used unbounded `response.json()` and `response.text()` calls, accepted any HTTP status and excessive structure depth, admitted extra fields, and replaced the embedded Canvas catalog seal with a new digest without first proving that seal.
- Repair: one startup reader now requires a successful readable response, enforces declared and streamed 16 MiB limits, decodes fatal UTF-8, caps structural depth at 64, validates exact catalog shapes and duplicate identity, and recomputes the embedded Canvas seal before any operation becomes executable.
- Regression: focused fixtures reject oversized declared and streamed responses, malformed UTF-8, depth 65, HTTP 404, a zeroed Canvas seal, and extra Canvas or browser fields. The current shipped catalogs pass the same admission.
- Focused verification: all focused compatibility tests passed, `pnpm package:connector:check` passed, and the full unattended Bridge browser gate loaded the real worker and passed in 44 seconds.
- Remaining gate: the integrated repository check must pass with the final local-owner changes.

### 282: executable private-command compatibility identity

- Root cause: thirteen command-authoritative private Bridge operations used routes, methods, argument lists, attachment rules, and private result schemas that were absent from the public-catalog handshake digest. Runtime and extension builds could therefore pair across an incompatible private contract change.
- Repair: Canvas Connector now owns one versioned private compatibility manifest. Runtime constants derive from it. The extension constructs its executable manifest from the constants it will use, refuses startup if that value differs, and hashes it into compatibility schema v2.
- Regression: runtime and extension manifests are byte-identical. Changing the private Canvas conversation route changes both the private digest and the outer handshake identity. The current handshake fixture still pairs.
- Focused verification: Canvas Connector built and passed all 60 tests. The combined digest and Item Bank group passed all 9 tests. Connector package checking and the real Bridge browser gate passed.
- Remaining gate: the integrated repository check must pass after the modern-owner repair.

### 281: one accepted browser-catalog normalization

- Root cause: runtime trimmed admitted strings before hashing, while the extension hashed raw accepted values. A catalog containing surrounding whitespace was valid on both sides but generated two handshake identities.
- Repair: extension admission now mirrors the runtime normalization and validation for keys, tools, review contracts, data class and family, presentation fields, flags, exact Moodle integer schemas, duplicate identities, and review-tool resolution. The normalized catalog is the one used for execution and hashing.
- Regression: a catalog with accepted surrounding whitespace now produces the same compatibility digest on both sides. Duplicate identities created by normalization are refused.
- Focused verification: all 7 compatibility-digest tests passed, Canvas Connector passed all 60 tests, and the actual service worker paired in the full browser gate.
- Remaining gate: the integrated repository check must pass after the final MCP changes.

### 280: exact legacy Edit-permission migration

- Root cause: compatibility schema v2 correctly changed the scope digest, but startup treated every prior digest as revoked. Users lost an otherwise identical exact action grant after a documentation-only catalog upgrade.
- Repair: startup computes the precise former raw-catalog formula and migrates only a permission that validates against that digest and the current exact operation set. It preserves categories and expiry, publishes the new digest atomically with a monotonic revision, and invalidates every previously prepared command.
- Regression: the exact old permission migrates from stored revision 4 to revision 5, retains its categories, becomes valid under the new digest, and invalidates the old prepared plan. An unrelated old digest does not migrate.
- Focused verification: all 25 Bridge settings contracts passed, service-worker syntax passed, and the real worker passed the unattended browser gate.
- Remaining gate: the integrated repository check must pass after the final MCP changes.

### 279: complete extracted Item Bank dependencies

- Root cause: the conformance harness rebuilt production service-worker functions with `Function(...)` but did not inject the newly required canonical `stableJson` helper. The full Gateway gate therefore changed a verified Item Bank write into an internal error even though focused extension execution passed.
- Repair: both extracted Item Bank lifecycle and recovery planners now receive the same canonical serializer as the production worker. The failing dispatch is retained as a local assertion value so the test exposes its exact result without console noise.
- Regression: the former result `canvas_item_bank_update_item: stableJson is not defined` now completes the deterministic verified-write path.
- Focused verification: both Item Bank conformance cases passed in 14.04 seconds. The combined compatibility and conformance group passed all 9 tests.
- Remaining gate: the complete Gateway suite must pass under integrated load.

### 278: platform-neutral Playwright-managed browser proof

- Root cause: the maintenance harness treated the macOS executable name `Google Chrome for Testing` as proof of browser provenance. Playwright 1.62.1 downloads Chrome for Testing from the same product feed on Ubuntu, but its registered executable is `chrome-linux64/chrome`. The new CI browser step would therefore fail before launching the extension.
- Repair: both unattended Bridge harnesses now use one launcher that delegates executable selection to the installed Playwright `chromium` object and refuses caller-supplied `channel` and `executablePath` overrides. This binds the run to Playwright's managed revision without platform-specific filename inference.
- Regression: unit tests prove the launcher passes ordinary options unchanged and refuses both a Chrome channel and an explicit system Chrome path before Playwright is called.
- Focused verification: launcher and harness syntax passed. Both launcher regressions, all 3 CI contract tests, and all 22 release-gate tests passed.
- Remaining gate: run both unattended real-browser harnesses through the repaired launcher before this row becomes `VERIFIED`.

### 277: source-derived connector package check

- Root cause: `--check` rebuilt the Bridge archive in memory, then unconditionally opened the expected ZIP and receipt under `artifacts/connector`. Git tracks neither output. A clean checkout therefore failed with `ENOENT` even when every packaged source byte was valid.
- Repair: check mode now creates the complete archive and receipt in memory, repeats the deterministic archive build, and verifies the rebuilt bytes and receipt digest without reading or writing an external artifact. Normal package mode still writes both files and verifies the archive exists.
- Regression: a process test runs the real package script with `--check`, requires a complete SHA-256 receipt, and proves that neither artifact is created, removed, nor changed. The Bridge release allowlist also requires the new compatibility module.
- Focused verification: `pnpm package:connector:check` passed from this checkout with no connector artifact present. All 11 connector-package, provider-scope, and desktop target tests passed.
- Remaining gate: the integrated repository check and deterministic release rebuild must pass before this row becomes `VERIFIED`.

### 276: real Bridge browser proof in pull-request CI

- Root cause: the workflow installed Playwright Chromium, but the authoritative `pnpm check` graph intentionally excluded headful browser harnesses and the workflow never invoked their separate runner. Two real product-flow regressions in findings 272 and 273 therefore survived the nominal repository gate.
- Repair: pull-request and `main` CI now run the unattended browser-harness runner under Xvfb after the repository check. The job limit is 30 minutes so the bounded 10-minute connector and 5-minute maintenance limits can finish without consuming the whole job budget.
- Regression: the CI contract requires the exact Xvfb browser command after `pnpm check`, the existing runner contract requires both unattended real-browser harnesses, and the workflow still pins Chromium installation and immutable action revisions.
- Focused verification: all 20 CI, desktop-gate, connector-package, release-copy, and response-body contract tests passed.
- Remaining gate: the full repository check and the complete browser harness must pass again after the compatibility-digest repair before this row becomes `VERIFIED`.

### 275: operational catalog compatibility identity

- Root cause: the MCP runtime combined the Canvas API catalog digest with raw SHA-256 hashes of both browser-catalog files. The extension repeated that formula. Canvas source timestamps, source URLs, raw JSON formatting, summaries, descriptions, documentation links, and schema help text therefore acted as execution identity even though they cannot change admission, request transport, dispatch, or readback.
- Repair: one versioned compatibility projection now keeps only fields that can change execution. It strips JSON Schema annotation keywords without removing fields named `title` or `description`. Raw browser-catalog digests remain unchanged as provenance evidence. The final Bridge identity binds the Canvas API, Canvas browser, and Moodle browser operational digests under one versioned contract. The extension owns an equivalent browser-safe projection, and all test Bridge clients use one production-equivalent fixture.
- Regression: Canvas tests prove transport and presentation edits preserve compatibility while route edits change it. Browser tests prove summary, description, documentation, raw-byte, and schema-help changes preserve compatibility while an operation-key change does not. A cross-runtime test requires the extension and TypeScript projections to produce byte-identical canonical JSON for all three shipped catalogs.
- Focused verification: all 43 Canvas API catalog tests and all 60 Canvas Connector tests passed. Four targeted Gateway digest and integration tests passed. The 17 copied Gateway digest helpers were removed, and all 20 related script contracts passed.
- Remaining gate: the complete Gateway suite, repository check, and real browser handshake must pass before this row becomes `VERIFIED`.

### 273: browser fixture proves pre-upload filename admission

- Root cause: the file-transfer executor added a bounded exact filename search before upload, while the full synthetic Canvas server still implemented only the upload-initialization POST at that folder route. The synthetic GET fell through to refusal.
- Repair: the browser fixture now requires the authenticated exact `search_term`, `per_page=100`, and `only[]=names` query and returns a complete empty result before it permits upload initialization.
- Regression: the current browser flow cannot dispatch the reviewed upload unless the production collision guard makes its exact authenticated preflight request.
- Focused verification: request diagnostics proved the failed run stopped at `GET /api/v1/folders/81/files` with no storage request. The repaired full browser run must pass before this row becomes `VERIFIED`.
- Remaining gate: rerun and inspect the complete current-worktree Bridge browser harness.

### 272: browser proof binds the exact accessible course target

- Root cause: focused settings regressions moved checkbox identity to the exact provider, course, ID, site, and account label, but the full browser flow still selected courses by the old name-only label.
- Repair: one browser-test helper derives the exact accessible name from the synthetic Canvas origin, principal, native course ID, and course name for available and connected states.
- Regression: the complete Bridge flow can continue only when all three discovered courses and the later keyboard-selected connected course expose their exact target identities.
- Focused verification: the pre-repair browser run timed out at the first old label after completing pairing and privacy checks. The repaired full browser run must pass before this row becomes `VERIFIED`.
- Remaining gate: rerun and inspect the complete current-worktree Bridge browser harness.

### 271: one evidence section per product state group

- Root cause: the inventory carried two identical consecutive headings, and no structural documentation check rejected the empty section.
- Repair: the duplicate heading was removed so the checklist explanation has one owner.
- Regression: direct source inspection proves one `The five checks` heading remains.
- Focused verification: the complete 11-test first-run inventory gate passed.
- Remaining gate: the complete integrated repository check must pass before this row becomes `VERIFIED`.

### 270: generated public prose obeys the release writing contract

- Root cause: generated provider metadata was covered by the repository prose gate only in the late integrated script suite, so a catalog regeneration retained forbidden punctuation until the full gate.
- Repair: the Assignment description now uses direct punctuation while preserving its exact provider contract.
- Regression: the repository-wide prose test scans tracked source and public pages, including the generated catalog.
- Focused verification: both no-em-dash tests and both Moodle identifier-contract tests passed.
- Remaining gate: the generated-artifact check and complete integrated repository check must pass before this row becomes `VERIFIED`.

### 269: exact current source evidence in the first-run inventory

- Root cause: product changes moved update, course-selection, file-access, and review controls while the inventory kept hand-maintained line numbers from the prior layout.
- Repair: every failed control citation and every update-state range now points to the current line that owns the displayed text or action.
- Regression: the inventory gate checks every cited path and line and requires each control name and rendered state to appear at its cited source.
- Focused verification: all 11 first-run inventory tests passed.
- Remaining gate: the complete integrated repository check must pass before this row becomes `VERIFIED`.

### 268: idempotent updater lifecycle publication

- Root cause: the updater controller and its library adapter can both observe the same check or candidate transition. The shared transition function published even when status, version, and reason were unchanged.
- Repair: the transition boundary now returns the current immutable snapshot without publishing when all three public state fields are identical.
- Regression: the real update harness requires exactly one `checking` and one `available` notification before download and readiness. Existing controller and adapter regressions continue to cover generation, cancellation, failure, and installation paths.
- Focused verification: all 7 desktop update-harness tests and all 53 focused updater, adapter, and lifecycle tests passed.
- Remaining gate: the complete integrated repository check and current native desktop inspection must pass before this row becomes `VERIFIED`.

### 267: desktop claims execute against an admitted package graph

- Root cause: the documentation test fixture still created two schema-only manifests after packaging admission began requiring one complete content-addressed source, dependency, MCP runtime, Bridge release, destination, and target-runtime graph.
- Repair: the fixture now creates a small complete package graph and loads the actual electron-builder configuration through the same admission boundary as packaging.
- Regression: a documentation claim can reach config assertions only after every fixture byte is admitted against its declared graph.
- Focused verification: all 10 desktop documentation-claim tests passed.
- Remaining gate: the complete integrated repository check must pass before this row becomes `VERIFIED`.

### 266: desktop gate regression follows the authoritative check

- Root cause: the test duplicated the root check command and was not updated when dependency audits became its first required stage.
- Repair: the assertion now requires the exact current dependency-audit, generated-artifact, and test sequence.
- Regression: changing or omitting a root gate stage fails the desktop gate contract test.
- Focused verification: all 4 desktop gate tests passed.
- Remaining gate: the complete integrated repository check must pass before this row becomes `VERIFIED`.

### 265: generated-provider gate regression follows the authoritative graph

- Root cause: the CI regression treated the generated gate as Canvas-only after exact Moodle integer generation became mandatory.
- Repair: the test now binds the pull-request command to the full generated-provider sequence and proves the Moodle checker uses its checked mode.
- Regression: omitting or renaming the generated Moodle contract now fails the pull-request gate regression.
- Focused verification: both CI generated-artifact tests passed.
- Remaining gate: the complete integrated repository check must pass before this row becomes `VERIFIED`.

### 264: one privacy snapshot per complete response

- Root cause: the privacy boundary treated already protected learner references as fresh durable work. Every `Student A…` or `learner_…` occurrence reopened the encrypted vault and ran private-file admission before resolving and tokenizing the same identity again. Selected-course inventory then invoked an independent privacy projection for every audit child and every course scope, so record count and course count both multiplied durable vault transactions.
- Repair: plain text whose normalized UTF-16 offsets are identical now uses an exact direct-offset view. One vault transaction publishes every missing label for all response scopes and returns an immutable reference-to-label index from that exact snapshot. Repeated protected references use that index. Inventory groups records by exact learner scope and applies all groups through one batched vault snapshot while keeping a separate prepared redaction context for each scope.
- Regression: a persistent vault processes 2,000 existing protected references inside its fixed unit-test window. The MCP regression covers a 2,000-reference page, 100 distinct exact course scopes with bounded roster concurrency, and 2,500 large inventory targets before encrypted settlement.
- Focused verification: Gateway Core and Gateway TypeScript builds passed. All 41 privacy tests passed in 2.47 seconds. The three formerly slow MCP cases passed together in 12.21 seconds: the protected large page in 6.10 seconds, 100 exact course scopes in 2.77 seconds, and the 2,500-target bounded inventory in 2.50 seconds.
- Remaining gate: the complete integrated repository check must pass before this row becomes `VERIFIED`.

### 263: consent transition focus ownership

- Root cause: successful consent replaced the disclosure action with the connection flow while focus remained on the hidden `Agree and continue` button.
- Repair: after consent succeeds and the fresh connection state renders, focus moves to the first visible enabled connection action.
- Regression: the shipped popup proves that the initial disconnected flow moves focus to `Connect Morrow` after consent.
- Focused verification: all 14 shipped popup-page interaction tests passed.
- Remaining gate: inspect the current popup transition through the browser accessibility tree before this row becomes `VERIFIED`.

### 262: confirmation focus restoration

- Root cause: the confirmation moved focus to `Keep reviewing`, but cancellation hid that control without returning focus to the action that opened the confirmation.
- Repair: cancellation renders the reviewed Edit controls, then returns focus to `Save Edit access`.
- Regression: the shipped settings page proves focus enters the confirmation on `Keep reviewing`, then returns to the visible `Save Edit access` control after cancellation.
- Focused verification: all 22 shipped settings-page interaction tests passed.
- Remaining gate: inspect the current Bridge settings transition through the browser accessibility tree before this row becomes `VERIFIED`.

### 261: exact accessible Bridge course identity

- Root cause: connected-course and discovery checkboxes exposed only the display name. Provider course IDs are site-local, duplicate course names are ordinary, and the visible site and account context did not participate in the accessible name.
- Repair: one course-selection label now binds the provider, course name, exact course ID, learning-platform site, and signed-in account. Discovery labels also state that selection will connect the course.
- Regression: the shipped settings page now proves distinct exact labels for connected courses and for discovery results whose IDs include a 64-bit canonical decimal string.
- Focused verification: all 22 shipped settings-page interaction tests passed.
- Remaining gate: inspect the current Bridge settings page through the browser accessibility tree before this row becomes `VERIFIED`.

### 260: exact accessible course action identity

- Root cause: the Blackboard course list bound the target course only to `data-course-id`, which drives pointer and focus restoration logic but does not participate in the button's accessible name. Every unselected course therefore exposed the same “Allow Morrow” name, and every selected course exposed the same “Remove” name.
- Repair: each rendered course action now carries one escaped accessible name that includes the action, exact course title, and exact provider course ID. The shorter visible label remains beside the visible course title and ID.
- Regression: the real renderer state transition proves the Biology button is named `Allow Morrow to use Biology (_45_1)` before selection and `Remove Biology (_45_1) from Morrow` after selection.
- Focused verification: all 26 renderer state and interaction tests passed.
- Remaining gate: inspect the course list through the current native desktop accessibility tree before this row becomes `VERIFIED`.

### 45: split UTF-8 framing

- Root cause: the server converted each byte chunk to a string independently.
- Repair: one incremental UTF-8 `StringDecoder` now owns the complete stdio stream.
- Regression: `packages/mcp-server/test/strict-stdio.test.ts` splits two-, three-, and four-byte text at every wire-byte boundary.
- Focused verification: 3 tests passed; `packages/mcp-server` TypeScript build passed.
- Remaining gate: the integrated repository check must run again after the complete repair wave. Status remains `IMPLEMENTED` until that gate and direct subprocess inspection pass.

### 81: Lesson Review evidence text

- Root cause: sampled finding fields required one character but did not require a trimmed, printable value.
- Repair: source quotes, target quotes, concerns, proposed corrections, and reported limits now use one exact review-text contract.
- Regression: the modern continuation test supplies whitespace-only source and target quotes and requires refusal before the checker round.
- Focused verification: Lesson Review and strict stdio suites passed 6 tests; `packages/mcp-server` TypeScript build passed.
- Remaining gate: full integration and a final rendered report inspection. Status remains `IMPLEMENTED`.

### 77: native continuation preservation

- Root cause: the ordinary result-size boundary ignored the MCP control-result discriminator.
- Repair: a valid `input_required` envelope is privacy-projected and returned intact. Only ordinary results enter artifact storage.
- Regression: a continuation larger than the inline threshold retains `resultType`, `inputRequests`, and `requestState`; an ordinary large result still becomes an artifact.
- Focused verification: artifact, Edit, Private Chat, and Lesson Review suites passed 10 tests; `packages/mcp-server` TypeScript build passed.
- Remaining gate: direct large Edit and sampling continuation inspection through the final public server boundary. Status remains `IMPLEMENTED`.

### 82: inventory failure preservation

- Root cause: the final native egress dispatcher sent success and failure envelopes through the success-only inventory projector.
- Repair: bounded inventory failures now pass through the strict native privacy projection. Successful inventories still require the source-bound inventory projector.
- Regression: an aborted inventory produces `course_inventory_unavailable`, then crosses a real `GatewayRuntime` final egress boundary without being replaced by a privacy error.
- Focused verification: the 24-test course-inventory suite and `packages/mcp-server` TypeScript build passed.
- Remaining gate: the integrated repository check must pass before status becomes `VERIFIED`.

### 12 and 68: exact assistant identity

- Root cause: application filenames and a short fixed command-path list acted as product identity. Lifecycle readiness then trusted saved configuration without current product evidence.
- Repair: every Codex application candidate now requires the exact bundle identifier. Claude Code requires a real command, including `~/.local/bin` and absolute `PATH` entries, with executable permission and a bounded successful version probe. Desktop configuration remains recorded when the command disappears, but readiness requires both current detection and valid configuration.
- Regression: lookalike Codex bundles, Claude Desktop, filename-only Claude Code, relative `PATH` entries, non-executable commands, and failed probes cannot pass. A valid command in an absolute custom path does pass. A saved but unavailable assistant reports configured and returns to assistant selection.
- Focused verification: 59 assistant detection, assistant management, and installer controller tests passed.
- Remaining gate: packaged macOS inspection and the integrated repository check must pass before status becomes `VERIFIED`.

### 72: canonical legacy Bridge hello

- Root cause: the overlay copied its internal `donorRevision` field directly onto the wire, while the canonical Bridge schema requires `runtimeRevision` and rejects unknown fields.
- Repair: one overlay message constructor now maps the internal revision to the canonical wire field. The connection path can no longer assemble the hello ad hoc.
- Regression: the installed overlay constructor emits a hello that the real `parseBridgeHello` accepts exactly; the former extra field is rejected by the same parser.
- Focused verification: the Bridge protocol build and all 4 legacy overlay tests passed.
- Remaining gate: a real loopback handshake from a scratch legacy overlay must pass before status becomes `VERIFIED`.

### 79: one-shot Private Chat continuation

- Root cause: a signed continuation proved integrity, expiry, method, session, and client binding, but it had no consumption authority.
- Repair: each Private Chat round now carries a random signed round ID and expiry. A bounded session ledger claims the round synchronously before any Bridge relay. Reuse with the same reply is a duplicate; reuse with different content is a conflict. Neither can relay again. The server context can now share both the signing key and continuation ledger across modern per-request server instances.
- Regression: sequential replay returns `private_chat_unavailable` and leaves the Bridge exchange count unchanged. Two concurrent submissions through the public MCP tool produce one continuation and one duplicate error with one Bridge relay.
- Focused verification: all 4 Private Chat tests passed. Private Chat, Lesson Review, Edit access, and result-artifact suites passed 10 tests; `packages/mcp-server` TypeScript build passed.
- Remaining gate: the shared-owner modern-session test must pass before status becomes `VERIFIED`.

### 69: canonical Canvas identifier strings

- Root cause: the browser summary reader, gateway projection, route expectation, catalog schemas, and sort logic each converted Canvas identifiers to JavaScript numbers.
- Repair: course and assignment identifiers now remain canonical decimal strings from catalog input through page reads, Bridge results, gateway validation, sorting, and public output. Counts and time-window values remain numbers. Decimal ordering compares length and then digits.
- Regression: the page-world aggregation and full MCP integration now use course and assignment IDs above `Number.MAX_SAFE_INTEGER`, including multiple large assignment IDs in ordered gradebook output.
- Focused verification: the gateway TypeScript build, full MCP course-summary integration, and 2 browser course-summary tests passed.
- Remaining gate: catalog/package synchronization and the integrated repository check must pass before status becomes `VERIFIED`.

### 8: explicit Canvas form clears

- Root cause: request assembly used empty-string omission instead of the catalog field's presence and transport location.
- Repair: an explicitly supplied empty string is retained for optional Canvas form fields. The guarded Page body still requires its content guard, and omitted or null ordinary form values keep their separate semantics.
- Regression: a real `canvas_edit_assignment` content-script execution sends a renamed assignment with `assignment[description]=` present in its URL-encoded body.
- Focused verification: all 17 Canvas write-contract tests passed.
- Remaining gate: the full browser connector harness and integrated repository check must pass before status becomes `VERIFIED`.

### 63: roster-owned Moodle learner identity

- Root cause: the group-membership endpoint's decorated display label was treated as canonical learner identity, even though the exact-course roster already owns that identity.
- Repair: group read and write snapshots now carry stable user IDs only. The gateway resolves those IDs through the complete source-bound roster. Decimal ID sorting no longer converts IDs to numbers.
- Regression: a native group member label containing an email never enters the group snapshot. Group lifecycle digests use ID-only memberships, the public result emits learner tokens, and an unknown member ID still fails closed.
- Focused verification: all 3 group read and lifecycle browser tests and the full Moodle group privacy integration passed.
- Remaining gate: the integrated repository check must pass before status becomes `VERIFIED`.

### 64: semantic Moodle plugin-row parsing

- Root cause: the inventory reader treated every CSS class as protocol data and required a closed allowlist, although Moodle core and installed plugins add presentation, source, and update metadata classes that do not enter the result.
- Repair: the parser now requires exactly one valid type, component, and status identity, accepts at most one availability state, verifies the component cell and version, and ignores non-semantic row classes.
- Regression: normal `standard`, `additional`, `missing`, `newplugin`, and `updatable` classes and an arbitrary presentation class preserve the fixed inventory. Duplicate type, component, or status identity and conflicting availability states fail closed. Component mismatch and invalid version remain refused. Private display names, links, notes, and tokens remain omitted.
- Focused verification: both Moodle system-administration browser tests passed.
- Remaining gate: catalog packaging and the integrated repository check must pass before status becomes `VERIFIED`.

### 65: provider-defined Moodle copy identity

- Root cause: the progress table's second cell was named generically as `destination`, then compared with the requested full course name. Moodle renders the destination short name in that cell.
- Repair: the parsed field is now `destination_short_name`. Both pre-send duplicate detection and post-send verification compare it with the exact requested short name.
- Regression: the fixture stores the posted `shortname` in Moodle's progress row. A successful copy with distinct full and short names verifies, and changing only the full name cannot bypass detection of the same in-progress short name.
- Focused verification: both Moodle backup, restore, import, and copy browser tests passed.
- Remaining gate: catalog packaging and the integrated repository check must pass before status becomes `VERIFIED`.

### 40: durable Bridge update commit

- Root cause: the browser-native UUID method was detached from its receiver. The update protocol also had only quiesce, rollback resume, and readback; a proven newer worker had no valid action that could retire the older worker's durable fence.
- Repair: UUID generation now uses a receiver-preserving closure. A new commit control binds the prior version, strictly newer current version, exact quiesce epoch, extension identity, active-folder proof, and held installer lease. The Bridge stores an idempotent commit receipt before it removes the fence. The app keeps its local update record pending until that commit succeeds, then finalizes its record and releases the lease.
- Regression: the production UUID default creates a valid epoch. Old-version, wrong-epoch, wrong-identity, malformed, and unproved commits fail closed. A valid newer worker clears the fence, admits its first write, and answers an uncertain-response retry from the durable commit receipt. A failed commit retains both the local pending record and maintenance lease.
- Focused verification: Bridge maintenance 16/16, coordination and update 14/14, runtime-monitor 8/8, Bridge protocol 17/17, canvas connector runtime 17/17, Bridge loopback 16/16, local-owner integration 5/5, and combined installer tests 63/63 passed.
- Remaining gate: the packaged scratch `1.0.2` to `1.0.3` browser upgrade and integrated repository check must pass before status becomes `VERIFIED`.

### 47: single native-tool manifest

- Root cause: catalog collision reservations, batch exclusions, and native registration sites each maintained separate name lists. The reservation list omitted newer inventory and New Quiz tools and also retained a name that no native tool registered.
- Repair: one typed manifest now owns every native name, surface, and collision policy. Gateway catalog merge derives its reservation set from that manifest. Batch and compatibility exclusions derive from the same descriptors. The manifest rejects invalid or duplicate names at module load.
- Regression: a conformance test extracts every literal and data-driven native registration and requires exact equality with the manifest. It also collides every manifest name through a real catalog merge. A public stdio matrix verifies the three original missing names through legacy and modern clients with compact and full catalog surfaces; each native name appears once and each source collision receives its declared alias.
- Focused verification: the manifest tests passed 2/2, public protocol integration passed 9/9, and the gateway TypeScript build passed.
- Remaining gate: full packaged server checks must pass before status becomes `VERIFIED`.

### 70: bounded opaque Canvas discovery cursors

- Root cause: the course-discovery path reinterpreted Canvas pagination as a local integer sequence and rejected provider-owned cursor parameters.
- Repair: the content script now preserves the provider's exact next URL. Both the page boundary and the service worker independently require HTTPS, the current Canvas origin, the exact courses path, no user information, no fragment, and a 4 KiB limit. The receipt stores canonical visited URLs for at most 100 pages. Repeated links and page-limit overruns fail before another provider request.
- Regression: the browser harness follows an opaque bookmark URL and a numeric URL unchanged. It also tampers the stored receipt with foreign, wrong-path, credentialed, empty-fragment, oversized, malformed, repeated, and over-limit values and proves that none reaches Canvas.
- Focused verification: the full Canvas connector browser harness passed. The workspace TypeScript build and JavaScript syntax checks passed.
- Remaining gate: the integrated repository check and packaged connector synchronization must pass before status becomes `VERIFIED`.

### 56: exact Moodle enrolment effect

- Root cause: enrolment verification treated any resulting participant record as proof and ignored both Moodle's rejected-form redisplay signal and the saved role and method identities already present in the participant row.
- Repair: the reviewed manual-enrolment row now binds its exact method label. A redisplayed native form is a confirmed refusal. A redirected submission verifies only when the learner has exactly the selected saved role ID and one enrolment through that bound method.
- Regression: a same-instance concurrent enrolment with another role is refused. Redirected responses that save the wrong role or the wrong method remain unconfirmed. The exact role and method control still verifies once.
- Focused verification: all 3 enrolment executor and candidate resolver browser tests passed.
- Remaining gate: the full connector browser suite and integrated repository check must pass before status becomes `VERIFIED`.

### 61: resolved and signed release evidence

- Root cause: external release receipts accepted a syntactically valid digest and a free-form verifier without resolving any retained bytes or authenticating an authorization identity.
- Repair: every required receipt now resolves one bounded evidence file below a declared evidence root and rehashes its bytes. The release evidence policy classifies each required receipt. Authorization receipts must carry an Ed25519 signature from a configured trusted public key over the exact evidence reference, commit, catalog digest, candidate digests, and verification time. The repository policy contains no invented trust key, so real authorization stays blocked until release governance configures one.
- Regression: matching retained evidence and trusted signatures pass. An unknown digest, changed evidence bytes, an unknown signer, missing policy, or unsigned authorization fails the corresponding release gate.
- Focused verification: all 10 release-gate tests passed, including candidate staging and fresh receipt revalidation.
- Remaining gate: defects 16-19 and 75-76 must complete the wider release evidence graph, then the integrated repository and package gates must pass before this row becomes `VERIFIED`.

### 18: single frozen release version

- Root cause: release profiles and packaging code carried independent version literals that drifted from the product manifests.
- Repair: the exact `package.json` bytes at `HEAD` now own the validated semantic version and its digest. Candidate name, archive path, stage manifest, SBOM, receipt, and conformance read that identity. A selected desktop installer manifest must match it. Release profile schema v2 has no version field.
- Regression: a synthetic `7.4.3` source produces `7.4.3` candidate names, paths, manifests, and receipts. Root identity drift and installer drift fail before packaging.
- Focused verification: all 11 release-gate tests and all 3 publication-policy tests passed.
- Remaining gate: package both real profiles after the final source commit and verify their manifests and receipts before status becomes `VERIFIED`.

### 19: isolated rebuild required for promotion

- Root cause: the optional rebuild proof zipped the same in-memory entry array twice in one process, and promotion did not require even that weak result.
- Repair: a requested rebuild now starts a separate Node process against a fresh detached Git clone at the exact candidate commit. The second process repeats profile selection, transformations, stage-manifest construction, SBOM construction, checksums, and archive creation. Commit, tree, profile, and final digest must all match. Promotion and stable promotion always block when this proof is absent.
- Regression: an isolated rebuild records its source and runtime subjects and matches the package digest. A diagnostic build without the proof is built but is never promotable or stable-ready. Conformance requires the proof for both release profiles.
- Focused verification: all 11 release-gate tests passed, including independent process and checkout execution.
- Remaining gate: run isolated rebuilds for both real profiles from the final committed source and inspect their receipts before status becomes `VERIFIED`.

### 17: current release evidence at final conformance

- Root cause: final conformance trusted the historical `passed` value embedded in the candidate receipt for live and client evidence.
- Repair: conformance now rebuilds the exact current candidate binding and reopens, rehashes, and reauthenticates external and promotion evidence. Candidate receipt fields remain historical observations only.
- Regression: final conformance first accepts current retained evidence, then the same candidate fails immediately after one evidence file is changed without rebuilding.
- Focused verification: all 11 release-gate tests passed, including current-evidence withdrawal after candidate staging.
- Remaining gate: defects 16 and 75 complete the provider policy and exact staged-byte evidence subjects. Then real final conformance must pass from the final commit before status becomes `VERIFIED`.

### 16: provider-derived release evidence policy

- Root cause: release code owned one fixed receipt list that did not represent the providers actually shipped by a profile.
- Repair: release profile schema v2 names every included provider. Each provider must name one authorization receipt and exactly one live proof or signed live-proof exception. Canvas and Moodle require live proof. Blackboard requires an explicit signed no-live-tenant exception. Shared client and promotion evidence remain separate declared profile requirements. The release gate derives its exact receipt set from this policy.
- Regression: the contract fixture independently requires Canvas authorization, Canvas live proof, Moodle authorization, Moodle live proof, Blackboard authorization, the Blackboard signed exception, and client parity. Removing any one independently blocks the selected profile. Missing or ambiguous provider policy fails closed.
- Focused verification: all 15 release-gate and publication-policy tests passed.
- Remaining gate: supply current retained evidence and trusted authorization keys for the final candidate. No publication authorization was created in this work. Status remains `IMPLEMENTED` until real final conformance passes.

### 83: bounded Blackboard effect-grant lifetime

- Root cause: a Gateway process secret could remain live longer than the fixed receipt-retention window, while its signed grants carried no time boundary.
- Repair: Blackboard effect grants now use a versioned contract with signed `issuedAt` and exclusive `notAfter` values. The source accepts only current grants with a maximum five-minute lifetime. Each receipt stores its signed deadline. A settled receipt is pruned only after both its audit-retention window and grant deadline end. Historical rows without a deadline are retained.
- Regression: a full private apply rejects an expired correctly signed grant before a provider request. Boundary tests reject future, expired, and overlong grants. Retention tests keep a receipt through a later signed deadline and prune it only after that deadline.
- Focused verification: all 235 Blackboard package tests and the Gateway Blackboard integration tests passed.
- Remaining gate: the integrated repository check and regenerated packaged catalog must pass before status becomes `VERIFIED`.

### 84: transactional Blackboard durable state

- Root cause: each process cached a complete effect or session map and atomically replaced the shared file from that stale map. Atomic rename protected file shape but did not protect the read, decision, and transition as one transaction.
- Repair: one shared durable-state primitive now serializes cooperating processes with an exclusive private lock. Every transition fresh-reads current state, increments a durable revision, fsyncs the new file, atomically replaces it, and fsyncs the directory. Effect claims recheck receipt and target inside the same transaction. Multi-row comparison settles in one commit. Session generations use the same transaction and stale cached bindings are refused.
- Regression: two independent effect-store instances can no longer erase each other's receipt. An operating-system child holds the lock while another writer proves it waits. Two session owners produce one monotonic generation and the earlier binding becomes unusable.
- Focused verification: 19 durable effect/session regressions, all 235 Blackboard package tests, and the Gateway Blackboard integrations passed.
- Remaining gate: the integrated repository check and packaged restart inspection must pass before status becomes `VERIFIED`.

### 85: complete source-operation idempotency identity

- Root cause: source-operation reuse compared only tool, source, catalog, and request digests. It omitted the frozen authority, authorization, binding, readback, and correction lineage that determine what a verified operation means.
- Repair: source-operation reuse now compares a digest of the complete frozen plan. The self-reported requester remains the only explicitly non-authoritative plan field. Any other change refuses the reused identity.
- Regression: an exact retry returns the one verified record. A changed provider principal or generation, Edit authorization, or readback digest is refused with the exact identity-conflict error.
- Focused verification: all 11 effect-broker tests passed.
- Remaining gate: the operation-journal package suite and integrated repository check must pass before status becomes `VERIFIED`.

### 86: source and outer verification join

- Root cause: source task `outcome` text took precedence over contradictory status, terminal, verification, and count evidence. Batch reconciliation then ignored the outer operation produced by its own frozen readback.
- Repair: source task settlement is now one strict state machine. Success requires completed status, succeeded outcome, terminal true, verified source evidence, at least one done effect, and zero unconfirmed, failed, rollback-failed, skipped, undone, or not-started counts. After source success, reconciliation reads the authoritative outer operation. Any unverified outer readback rewrites the child to nonterminal inspection-required state before summary or batch finalization.
- Regression: contradictory source success becomes inspection-required. A source that claims valid success while its outer readback mismatches cannot complete its batch and reports `providerOutcomeFinal: false`. The fully verified control still completes once.
- Focused verification: all batch settlement tests and all 19 Gateway batch integration tests passed.
- Remaining gate: the full batch-engine, operation-journal, Gateway, and integrated repository checks must pass before status becomes `VERIFIED`.

### 95: isolated frozen runtime dependencies

- Root cause: the desktop packager resolved executable third-party packages through the active workspace and treated Git status as the complete source identity. Its per-file seal preserved whatever bytes the mutable `node_modules` tree supplied.
- Repair: packaging now creates a separate production-only pnpm workspace, requires the exact `packageManager` version, installs with the frozen lockfile, offline mode, disabled scripts, and store-integrity verification, and resolves every runtime dependency only from that isolated tree. The package input and desktop receipt bind the lockfile SHA-256, declared and observed pnpm versions, exact install mode, resolved dependency versions, and each lockfile SHA-512 integrity value. Package input schema v2 makes the desktop builder and installed runtime reject legacy payloads created before this invariant.
- Regression: a synthetic source workspace resolves `@iarna/toml` to an altered live package, then the release materializer returns clean isolated bytes with the exact frozen-lockfile binding. Payload provenance tests also require every allowlisted runtime dependency and integrity record. Desktop builder and startup tests reject the v1 input schema.
- Focused verification: all 3 package-provenance tests passed. The affected desktop builder, runtime, adversarial, controller, documentation, and target suites passed 82 tests with one Windows-only skip.
- Remaining gate: the integrated repository check and a final packaged desktop inspection must pass before status becomes `VERIFIED`.

### 96: artifact-bound Windows smoke evidence

- Root cause: the native smoke observation named no source commit, installer digest, or run. Its harness named only the installer basename, so the zero-tolerance validator could join smoke and repair results from one EXE to a retained EXE and upgrade receipt from another run.
- Repair: every healthy, damaged, and repaired observation is now wrapped in an exact evidence binding with the source commit, installer basename, installer SHA-256, and fresh run ID. The harness repeats that binding and embeds the bound observations. Zero-tolerance validation recomputes the retained EXE digest and requires the smoke, harness, repair observations, upgrade receipt, and requested commit to share the applicable source and artifact identity.
- Regression: two valid evidence sets with the same installer filename but different bytes and run IDs cannot be mixed. A harness with a different run ID is also rejected. The same-artifact fixture remains accepted.
- Focused verification: the Windows smoke contract, desktop release workflow, and zero-tolerance receipt suites passed 42 tests.
- Remaining gate: the native Windows release workflow must produce and validate one current schema-v5 harness before status becomes `VERIFIED`.

### 97: required generated Canvas CI gate

- Root cause: pull-request CI ran `pnpm check`, but that command entered the test graph without first running the existing byte-exact generated Canvas checks.
- Repair: the root `check` command now runs one non-mutating `generated:check` gate before tests. That gate checks the Canvas catalog and mirror, all three generated readback/admission modules, the admission report, and the generated Classic Quiz question contract.
- Regression: a structural test binds the exact CI command to the generated gate and each `--check` implementation. In a scratch checkout, a one-byte drift in `connector/extension/generated/canvas-readback-plan.js` made the exact `pnpm check` command exit 1 with `Generated Canvas module is stale` before tests.
- Focused verification: the CI generated-artifact contract test passed. `pnpm generated:check` passed against the synchronized worktree.
- Remaining gate: the complete required `pnpm check` run must pass before status becomes `VERIFIED`.

### 98: strategy-complete signing preflight

- Root cause: the preflight treated one fixed Apple-ID credential list as mandatory and reduced workflow readiness to the presence of any signing-shaped secret reference. It rejected API-key notarization and could accept a workflow that did not wire notarization or Windows credentials into a signed package step.
- Repair: preflight schema v2 models certificate and keychain macOS signing, Apple-ID, API-key, and keychain-profile notarization, and Windows certificate signing as explicit alternatives. Each selected strategy requires its complete local environment, direct secret-to-environment wiring in the matching package step, `MORROW_SIGNED_RELEASE=1`, and one shared macOS step for signing and notarization. The receipt reports strategy identifiers and secret names without secret values.
- Regression: complete Apple-ID, API-key, and keychain-profile fixtures pass. Empty and mixed strategies, one-secret workflows, secrets outside the package step, disabled signed mode, and macOS credentials split across package steps all remain blocked.
- Focused verification: all 18 release-signing preflight tests passed.
- Remaining gate: real signing, notarization, and platform signature inspection remain separate release gates before status becomes `VERIFIED`.

### 20, 58, and 99: receipt-owned Blackboard create identity

- Root cause: create comparators searched whole collections for values that resembled the reviewed request. They did not know which object the approved POST created, and one broad target comparison could settle the source hold.
- Repair: each assignment, group, and announcement POST now persists the exact provider-returned identity under the spent source receipt before its first GET. Create reconciliation requires the Gateway process ID, effect receipt ID, outer operation ID, exact target, create kind, and fresh GET of that exact provider identity. Missing identity evidence stays unconfirmed. A comparison can settle only its exact receipt. Legacy rows with no provider identity stay unresolved. The Gateway no longer calls create comparators before dispatch and injects the receipt identity only during reconciliation.
- Regression: a failed assignment POST with an old matching grade column, a failed group POST with an old matching group, and a failed announcement POST with an old matching announcement all remain unconfirmed and keep their source target held. A wrong receipt cannot read or settle persisted create evidence. The full Gateway announcement flow verifies only its own receipt and uses one POST.
- Focused verification: 72 assignment, group, announcement, and effect-record tests passed. The Blackboard source and Gateway builds passed. All 5 Blackboard Gateway integrations passed.
- Remaining gate: all Blackboard package tests and the integrated repository check must pass before these rows become `VERIFIED`.

### 30: official assignment result identity

- Root cause: the assignment adapter read the invented response field `gradebookColumnId` instead of Blackboard's `gradeColumnId`.
- Repair: assignment dispatch now accepts `gradeColumnId`, persists it as receipt-owned provider evidence, and re-reads that exact column. Morrow's own stable result field remains `gradebookColumnId` after the provider boundary.
- Regression: the official-shaped create response completes the exact assignment and column readback. A response without `gradeColumnId` stays applied-or-unknown and names the missing provider field.
- Focused verification: all 18 assignment tests and the Blackboard source build passed.
- Remaining gate: the complete Blackboard package and integrated repository checks must pass before status becomes `VERIFIED`.

### 31: Blackboard announcement duration adapter

- Root cause: public Morrow values `Continuous` and `DateRange` were sent to and compared directly with provider values that use a different vocabulary.
- Repair: the provider boundary now maps `Continuous` to `Permanent` and `DateRange` to `Restricted` on writes, and maps both values back before public projection, frozen patch state, and readback comparison.
- Regression: requests carry provider-native values while list, read, create, patch, and comparator results retain the public Morrow values. A provider `Permanent` record cannot verify a reviewed `DateRange` announcement.
- Focused verification: all 20 announcement tests and all 5 Blackboard Gateway integrations passed.
- Remaining gate: the complete Blackboard package and integrated repository checks must pass before status becomes `VERIFIED`.

### 28, 29, 30, 31, and 32: checked Blackboard provider contract

- Root cause: operation modules repeated provider field names, record identities, scope rules, enum values, and grade semantics. Their fixtures repeated the same assumptions, so internal tests could pass while official provider shapes failed.
- Repair: one provider-contract adapter now owns the pinned Swagger identity and the exact response facts Morrow uses. Group membership collections declare `userId` as their identity. Content records are bound by the exact request path and returned `id`; an optional `courseId` must agree, but absence is valid. Assignment creation, announcement durations, and normal displayed grades pass through the same adapter. A checked compact artifact binds these facts to Learn Swagger `4000.21.0` and its SHA-256.
- Regression: official group memberships with only `userId` pass, while missing and repeated `userId` values fail. Content reads, file plans, dated visibility, assessment reads, and assignment readback pass without an invented `courseId`; a conflicting optional field fails. Official assignment identities and announcement values round trip. A normal `displayGrade` returns score, possible points, scale, and privacy-checked text separately from top-level override values.
- Focused verification: the provider-contract, transport, group, assignment, announcement, gradebook, privacy, file, lifecycle, and course-content suites passed 160 tests. The Blackboard source TypeScript build passed.
- Remaining gate: the complete Blackboard package, Gateway integrations, checked catalog generation, and integrated repository check must pass before these rows become `VERIFIED`.

### 59 and 100: exact-course Blackboard privacy projection

- Root cause: a prepared roster carried learner identities for one course but no explicit course binding. Account-wide course discovery and course-copy readback could project another course's free text through that roster.
- Repair: every prepared roster now names its exact provider course. A text projector refuses a roster from another course. Account-wide and copied-course outputs use an identity-only projection for every course without its own prepared roster. That projection exposes only the opaque provider ID, safe provider state, connection state, and a stable `course_roster_unavailable` marker. It withholds Blackboard Course ID, name, and description.
- Regression: another course carries a learner name in its Course ID, name, and description. None leaves the source or full Gateway subprocess. The selected course still uses its own roster, and account-wide discovery performs no other-course roster reads. A completed course copy no longer enters an uncertain effect state merely because its destination roster is unavailable.
- Focused verification: 21 source privacy and course-content tests, all 24 course-lifecycle tests, the 160-test Blackboard contract cluster, and the full Blackboard Gateway egress test passed.
- Remaining gate: the complete Blackboard package and integrated repository checks must pass before these rows become `VERIFIED`.

### 1: connector-owned exact readback policy

- Root cause: connector planning accepted a caller-supplied `_morrow.readback` object before deriving the write's protected target. Generic reconciliation later treated that arbitrary read-only tool and digest as evidence for the saved write.
- Repair: every Canvas connector write now replaces caller input with the exact embedded readback policy derived from its frozen request. Verification and reconciliation recompute that policy from the saved operation and refuse historical records whose policy differs.
- Regression: a caller supplies an unrelated course and page comparator. The saved operation contains only Morrow's derived policy. A simulated legacy operation with the unrelated policy remains unconfirmed, performs no connector write or readback, and keeps its own target held.
- Focused verification: the Gateway TypeScript build and all 17 Canvas connector integration tests passed.
- Remaining gate: the complete Gateway and integrated repository checks must pass before this row becomes `VERIFIED`.

### 2 and 66: durable parent-batch effect authority

- Root cause: the batch database and effect journal recorded related state but no durable parent authority joined them. Cancellation changed only child rows. Partial creation quarantined only the batch. Direct dispatch therefore saw a valid standalone approval with no parent state to enforce.
- Repair: the effect journal now owns one durable batch-authority row and one exact child-to-operation binding. Write-batch creation registers the parent before exposing an effect. Dispatch reservation and parent revocation serialize through the same journal transaction. Revocation cancels every unsent effect. An effect that already reserved dispatch stays irreversible, and its child becomes unknown instead of cancelled. Source-settlement rows change with the same outcome. Startup restores legacy bindings before the approval server starts. Failed creation uses the same complete compensation path.
- Regression: cancelling an approved connector batch leaves the effect cancelled with zero dispatch attempts, sends zero writes on direct dispatch, and remains blocked after restart. The broker tests both transaction orders: cancellation first blocks reservation; reservation first remains visible with one dispatch attempt. A later child planning failure cancels the earlier outer effect, both batch children, and both source-settlement rows.
- Focused verification: all 18 operation-journal tests, all 27 batch-engine tests, the Gateway TypeScript build, and all 21 Gateway batch integration tests passed.
- Remaining gate: the complete Gateway and integrated repository checks must pass before these rows become `VERIFIED`.

### 3: complete guarded New Quiz postconditions

- Root cause: the content executor selected one specialized verifier for a guarded write. The settings verifier inspected only `quiz_settings`. The position verifier inspected only item order. Both ignored other valid fields carried by the same reviewed PATCH, and uncertain-response recovery reused the incomplete verifier.
- Repair: the settings guard now retains every requested non-settings quiz field and compares it against the same exact quiz reread used for the complete settings block. The position guard retains every requested non-position item field, re-reads the exact item after confirming the complete order, and compares the full requested shape. Normal completion and uncertain-response recovery call these same complete verifiers.
- Regression: a mixed settings and title PATCH verifies only when both the complete settings block and saved title match. A mixed item move and prompt PATCH verifies only when both the complete order and exact saved prompt match. Stale title and prompt fixtures fail after normal responses and remain unresolved after lost responses.
- Focused verification: 46 adjacent Canvas and New Quiz contract tests passed. The full Chrome for Testing connector browser campaign passed and reported one successful suite.
- Remaining gate: the complete extension and integrated repository checks must pass before this row becomes `VERIFIED`.

### 4: durable data-removal maintenance guard

- Root cause: data removal treated an installer monitor snapshot and proxy close as runtime ownership. It did not acquire the local owner's maintenance lease, did not wait for the owner process to exit, and removed State before any durable guard could protect the journal.
- Repair: removal now enters one controller-owned operation, acquires authoritative owner maintenance before showing the confirmation, commits owner shutdown, and waits for the exact owner PID to die. The committed lease is atomically rotated into a stopped-runtime guard, so startup remains fenced until State is removed. If no monitor exists, a verified maintenance helper writes the guard first and probes the exclusive runtime lock to prove that no owner is live. Cancellation releases the exact guard. A failed State deletion releases the stopped guard and reports the path as remaining.
- Regression: an owner that refuses maintenance causes removal to stop before confirmation and leaves every byte unchanged. The stopped-runtime path holds and releases its guard around cancellation. A child process keeps a real SQLite journal open and writes for 200 ms after commit begins; State remains present and the journal remains writable until the child closes, then removal deletes State. Maintenance unit tests prove that a live runtime lock blocks the stopped guard and that dead-owner lease rotation preserves a continuous marker.
- Focused verification: the Gateway TypeScript build passed. All 9 local-owner maintenance tests, all 3 runtime-state lease tests, all 5 real local-owner integrations, and all 36 installer-controller tests passed. The complete desktop suite passed 297 tests and retained one Windows-only skip.
- Remaining gate: the complete Gateway and integrated repository checks must pass before this row becomes `VERIFIED`.

### 57: source-bound Moodle course import

- Root cause: import verification ignored Moodle's final workflow document and treated any target activity ID absent from the preflight as imported. It never read the selected source course, so a precheck-error page plus an unrelated concurrent edit could satisfy the comparator.
- Repair: the import now freezes the complete selected-source course state and reads it again immediately before dispatch. A source change cancels the native workflow. The final POST must return Moodle's native success notification and no remaining import form. Target readback uses a counted activity signature of machine module, exact displayed name, and section number. Every source activity must have one newly created target match. Extra concurrent target activities are excluded from `activities_added`. The result carries the source snapshot digest.
- Regression: an HTTP 200 precheck-error page adds an unrelated Forum activity and remains unconfirmed. A success page that adds only an unrelated activity also remains unconfirmed. A source change after the form opens cancels before import dispatch. The exact source Page import still verifies and reports only its matched new target activity.
- Focused verification: 29 Moodle backup, route, documentation, live-proof, browser-executor, and digest-contract tests passed in Chrome for Testing and Node.
- Remaining gate: the full connector browser campaign and integrated repository check must pass before this row becomes `VERIFIED`.

### 60: launch-bound local source attestation

- Root cause: the Gateway verified a configured Git root once, then every initial connection and reconnect spawned independent command, argument, working-directory, and environment strings. A clean one-file decoy repository could therefore attest an MCP server executed from another checkout.
- Repair: each local Git attestation now declares one repository-relative entrypoint argument and one runtime identity. The Gateway requires the exact canonical worktree root as its working directory, resolves the executable through the actual child environment, binds the current Node binary or an explicit executable digest, proves the entrypoint stays inside the worktree, and requires an exact digest for ignored or untracked build output. It replaces the entrypoint and executable with their canonical paths and computes one launch digest over the revision, paths, byte digests, complete arguments, and exact environment. The same verifier prepares every startup and reconnect.
- Regression: a clean decoy repository paired with the former external test fixture fails before connection. Unit tests reject another-tree entrypoints and undigested build output, accept the exact sealed build artifact, and prove that startup retry prepares the launch again for every process attempt.
- Focused verification: the contracts, upstream transport, and Gateway TypeScript builds passed. All 11 upstream supervision tests and all 23 source-attestation, configuration, and public-profile tests passed. The complete package gate passed 21 tests.
- Remaining gate: the integrated repository check and final packaged runtime inspection must pass before this row becomes `VERIFIED`.

### 101: expand, then validate release evidence templates

- Root cause: revision and digest schemas accepted only final hexadecimal values even though shipped examples supplied environment templates. Expansion happened after schema validation, so the documented public release configuration could not load.
- Repair: the first parse accepts only a hexadecimal value or a syntactically valid environment template. Expansion now covers local revisions, attestation revisions, catalog truth, source patch, catalog, entrypoint, and executable digests. Provenance validation then requires each expanded revision and digest to have its exact final form before startup.
- Regression: the test suite loads the shipped public configuration with resolved release values and rejects a template that expands to `main` instead of a full Git object ID.
- Focused verification: the Gateway TypeScript build, 23 adjacent configuration and attestation tests, all 3 publication-policy tests, and the complete package gate passed.
- Remaining gate: the integrated repository check must pass before this row becomes `VERIFIED`.

### 87: exit-proved upstream process-tree shutdown

- Root cause: transport close ended stdin, sent `SIGTERM`, discarded the child reference, and reported closure without waiting for the operating system to report process exit. Upstream close also ignored an in-flight connection that had not assigned its client yet.
- Repair: strict stdio shutdown now owns one idempotent close promise and one complete process tree. POSIX upstreams start in their own process group. Windows shutdown uses `taskkill /T`. Shutdown requests graceful tree termination, waits for the root child, force-terminates the tree after a bounded grace period, and releases every pipe and listener if the operating system still cannot report root exit. The upstream waits for in-flight connection work. A connection closed during asynchronous launch preparation is refused before spawn.
- Regression: a real root child and its descendant both ignore `SIGTERM`. The root records the graceful signal, then forced process-group termination removes both PIDs before `close()` resolves. A second test closes an upstream during blocked launch preparation and proves no process starts afterward.
- Focused verification: the upstream package build and all 13 upstream tests passed. The complete 51-test Bridge protocol and Gateway protocol gate passed.
- Remaining gate: the integrated repository check must pass before this row becomes `VERIFIED`.

### 73: exact Private Chat cancellation propagation

- Root cause: the MCP abort signal reached the connector runtime but was checked only after the nine-minute Bridge promise settled. The loopback pending map and extension wait had no cancellation message or exact cancellation identity.
- Repair: Private Chat passes its signal into the loopback invocation. Abort atomically removes the exact pending request, rejects it with a typed cancellation result, and sends one protocol cancellation envelope bound to request ID, operation ID, and connection generation. The extension validates every field and clears only the matching current Private Chat wait. Results, disconnects, timeouts, and aborts share one listener and timer cleanup path.
- Regression: abort settles the connector call with `bridge_request_cancelled`, leaves the loopback pending count at zero, and emits the exact cancellation identity. Executing the extension handler proves that a wrong request ID preserves the wait and the exact identity clears it.
- Focused verification: Bridge protocol, loopback, and connector builds passed. All 17 protocol tests, 17 loopback tests, 18 connector runtime tests, and 8 Private Chat extension tests passed.
- Remaining gate: the complete connector browser campaign and integrated repository check must pass before this row becomes `VERIFIED`.

### 74: consent-owned Private Chat teardown

- Root cause: consent withdrawal detached `state.socket` before closing it. The socket close callback then rejected itself as stale and skipped the only Private Chat cleanup path.
- Repair: the consent listener now closes and erases Private Chat before it detaches the Bridge socket. It returns the local `closed` result while the authenticated socket still exists, then removes the generation and connection.
- Regression: a full service-worker fixture starts one pending assistant, withdraws consent, confirms the exact close result, reaccepts consent, reconnects at a new generation, and observes no old client or wait. A different assistant can then start without `private_chat_busy`.
- Focused verification: all 13 course-data consent and Private Chat extension tests passed.
- Remaining gate: the complete connector browser campaign and integrated repository check must pass before this row becomes `VERIFIED`.

### 55: event-driven Bridge Settings state

- Root cause: the worker broadcast `morrow_bridge_status_changed` after course-tab and connection changes, but Settings subscribed only to Private Chat events. These status changes do not always write storage, so the page had no second refresh trigger.
- Repair: the existing generation-protected `refresh()` path now handles both Bridge status and Private Chat events.
- Regression: the rendered Settings page starts with one ready course, receives the exact worker event after that course becomes unverified, and immediately changes to the course-tab-needed state. Plan recovery remains available and Edit becomes unavailable.
- Focused verification: all 21 rendered Settings tests passed.
- Remaining gate: the complete Chrome for Testing campaign and integrated repository check must pass before this row becomes `VERIFIED`.

### 53: complete, route-bound Hot Spot verification

- Root cause: the dedicated page executor compared only the created identity, question type, image URL, and list membership. It ignored the rest of the reviewed question. The generic outer worker then had no read route for the private service and replaced the specialized result with `no_safe_readback_route`.
- Repair: the page executor now compares every supplied question field recursively against the exact created-item reread, including points, position, title, body, calculator, feedback, answer shape, and coordinates. It also checks requested position in the complete membership reread. The service worker requires the exact private operation, result schema, payload digest, course, quiz, item, count, image URL, strategy, evidence, and ordered verification targets before it preserves the result. The private route is excluded from generic planning and has its own outer verification branch.
- Regression: changed or omitted author fields, changed answer shape or coordinates, and wrong position all produce a mismatch. A confirmed upload exercises the real worker executor through successful completion. The outer verifier refuses a generic service, altered evidence, and an unrelated payload digest.
- Focused verification: 53 adjacent in-page and New Quiz connector tests passed. All 43 Hot Spot planner, lifecycle, and Gateway integration tests passed.
- Remaining gate: the complete Chrome for Testing connector campaign and integrated repository check must pass before this row becomes `VERIFIED`.

### 5: complete ready-work batch scan

- Root cause: `claimPending` limited the pending SQL result before it checked dependencies. Execution concurrency one therefore inspected only four ordinal rows. A valid prerequisite at ordinal five or later could never be selected.
- Repair: the store now reads the complete pending set, which is bounded by the frozen 10,000-child manifest limit, evaluates dependency readiness in ordinal order, and stops only after it claims the requested execution limit. Candidate discovery and execution concurrency are separate controls.
- Regression: a 501-child batch places the only ready prerequisite after 500 blocked dependents. The first two processed children are the prerequisite and then the first dependent. The batch retains the other 499 pending children.
- Focused verification: the batch-engine build passed. All 23 batch-engine gate tests and all 40 Gateway batch integration tests passed.
- Remaining gate: the integrated repository check must pass before this row becomes `VERIFIED`.

### 102: close-listener ordering in restart tests

- Root cause: two restart tests awaited runtime shutdown, then subscribed to the fixture WebSocket `close` event. Exit-proved upstream shutdown can complete only after that event, so the tests subscribed too late and waited until their 45-second timeout.
- Repair: each test now creates its close promise before runtime shutdown. It asks the fixture socket to close only when shutdown has not already closed it.
- Regression: both previously hanging restart cases pass alone in about five seconds, and the complete 40-test Gateway batch gate passes.
- Focused verification: the complete batch gate passed after both listener-order repairs.
- Remaining gate: the integrated repository check must pass before this row becomes `VERIFIED`.

### 48: exact same-batch scheduler tail ownership

- Root cause: a cancelled queued run released its own gate and immediately deleted the batch tail by key. Its tail still contained the unfinished predecessor. A later run therefore saw no serialization barrier and could overlap the active run. Running-holder cleanup also deleted by batch key without proving that it still owned the stored holder.
- Repair: each run keeps the exact running-holder and tail objects it installed. Running cleanup deletes only that exact holder. Tail cleanup waits for the complete predecessor and current chain to settle, then deletes only if no later run replaced the exact tail.
- Regression: run A remains active, run B queues and cancels, and run C arrives after B's cancellation. C cannot start until A ends. Health reports the exact A and then C holders and retains no active or queued work afterward.
- Focused verification: all 17 scheduler tests passed. The complete batch gate passed 25 batch-engine tests and 41 Gateway tests.
- Remaining gate: the integrated repository check must pass before this row becomes `VERIFIED`.

### 49: durable source rate observations

- Root cause: each batch window rebuilt its rate policy from the frozen manifest and current call options. Trusted response cost, remaining-budget, and `Retry-After` observations existed only in local variables. A bounded window or process restart could therefore dispatch immediately after the provider required a delay.
- Repair: the batch store now owns one durable source-specific rate record with conservative cost and remaining-budget facts plus an absolute jittered not-before time. The record is committed before child settlement. A later window merges every source observation, waits only the exact remaining duration, and clears deadlines only after a successful wait. The immutable approved manifest remains unchanged. Stored timestamps are strictly validated and cannot encode a delay outside the ten-minute execution bound.
- Regression: the first one-child window records a 300 ms provider delay, closes the database, and leaves a second child pending. A reopened process waits exactly 300 ms before that child starts, retains concurrency one, and consumes the deadline. A corrupted day-long deadline is rejected before it can create an unbounded wait.
- Focused verification: the batch-engine build and all 13 focused requirement tests passed. The complete batch gate passed 25 batch-engine tests and 41 Gateway tests.
- Remaining gate: the integrated repository check must pass before this row becomes `VERIFIED`.

### 6: authority-bound person close-out evidence

- Root cause: the Gateway journal retained a read's source and payload digest but discarded its browser binding, provider target, actor, success, and public-delivery facts. Close-out then searched only 200 recent source responses. Any successful read from the same connector source could release an unrelated unresolved target, and later reads could evict valid evidence.
- Repair: each public course read now carries its verified binding scope into the journal. The journal stores only the source-binding, exact-target, and actor digests. It separately records provider success and records public delivery only after privacy projection succeeds. Close-out performs one indexed exact lookup across all six facts and the post-dispatch time boundary. Existing records without complete evidence remain unresolved.
- Regression: successful reads of another course and of the same target through another connection are refused. A failed read of the exact target is refused. The correct successful delivered read closes once. Journal tests prove that 201 later decoy reads cannot evict the exact evidence, a changed actor cannot match, and an existing database gains the new columns with old rows left untrusted.
- Focused verification: the operation-journal build and all 20 journal and broker tests passed. The Gateway build and all 17 Canvas connector integrations passed.
- Remaining gate: the integrated repository check must pass before this row becomes `VERIFIED`.

### 7 and 103: one official Classic QuizQuestion response contract

- Root cause: planning and browser execution carried separate hand-written response allowlists. Both lists omitted documented top-level and nullable type fields. Both also treated Canvas request names as response names, although the official API serializer returns saved answer keys such as `text`, `html`, `comments`, `comments_html`, and `weight`. The rebuild could not start for an ordinary response and could not preserve rich answer feedback.
- Repair: one pure contract in `packages/canvas-api-catalog` now validates the complete supported QuizQuestion response and converts stored answer keys to the complete indexed request form. It accepts documented `created_at`, null `regrade_option`, null type-specific fields, bank identity, and null essay answers. It keeps nonempty unsupported type state, grouped questions, unknown fields, conflicting aliases, and incomplete answers fail-closed. A deterministic sync step embeds that exact source in the classic content script, and connector packaging checks the embedded digest. The Bridge protocol carries either official response field names or compatible request aliases for the exact selected answer field. Rich `comments_html` is sent back as `answer_comment_html`.
- Regression: direct contract tests use the current official response shape and require exact request-key conversion. Planner and content-script tests accept official metadata and null fields, accept null essay answers, select an official `html` answer field, and refuse nonempty or unknown state before dispatch. The Chrome fixture rebuilds the response with official stored answer names, advances only `updated_at`, and compares every other saved field after question-text and answer-image repairs.
- Focused verification: the full workspace TypeScript build passed. All 4 contract tests, 9 planner tests, 18 Bridge protocol tests, and 17 content-script and generated-contract tests passed. The complete Chrome for Testing connector campaign passed with the exact saved-question comparison.
- Remaining gate: the integrated repository check must pass before these rows become `VERIFIED`.

### 9: path-bound OutcomeLink identity

- Root cause: collection readback treated every target identity as one flat field. The Canvas unlink rule therefore compared a linked-outcome row's top-level link `id`, while Canvas places the linked outcome identity at `outcome.id`.
- Repair: target fields now accept an explicit dot or bracket path through the shared path parser. The unlink rule binds only to `outcome.id`. Existing flat-field rules continue to use the same comparator.
- Regression: a remaining nested outcome ID produces `target_still_present`. A different remaining outcome verifies omission even when its top-level link ID equals the removed outcome ID. A nonempty malformed collection without `outcome.id` stays unconfirmed.
- Focused verification: the Canvas catalog build passed. All 12 readback tests passed. The generated Bridge readback module matches the catalog source, and `git diff --check` passed.
- Remaining gate: the complete connector browser campaign and integrated repository check must pass before this row becomes `VERIFIED`.

### 10: complete direct runtime integrity

- Root cause: the trusted MCP manifest sealed dependencies and mapped only the Gateway package back to its direct copy. The desktop app also launched direct client-config, connector, and monitor files whose bytes and directory topology were outside startup verification.
- Repair: runtime manifest version 2 carries every direct file beneath the packaged workspace trees and installer runtime tree. The producer derives that inventory from the sealed package-input destinations. Startup verifies every file digest, rejects symbolic or special entries, proves canonical containment, and compares the complete on-disk file set with the trusted inventory. Required CLI, Gateway, connector, and monitor entrypoints must all be present.
- Regression: separate fresh payloads reject damage to the direct CLI, connector, monitor, and a Gateway sibling. Startup also rejects an extra unsealed direct module and a link that resolves to the expected bytes. The payload producer test proves the trusted direct inventory equals the package-input inventory exactly.
- Focused verification: the Gateway and runtime syntax builds passed. The 72-test installer runtime, controller, adversarial, and monitor cluster passed with one Windows-only skip. The packaged Gateway identity integration passed 3 tests. The real payload provenance suite passed all 3 tests, and `git diff --check` passed.
- Remaining gate: the complete desktop suite, native package inspection, and integrated repository check must pass before this row becomes `VERIFIED`.

### 11: ownership-aware configuration privacy

- Root cause: the private-file writer applied Morrow's private-directory mode to the parent on every write, even when the parent was an existing project or home directory owned and shared by the person.
- Repair: recursive creation now returns whether it created the parent path. Morrow applies its private-directory mode only to a parent it created. The configuration file remains restricted to the current account and mode `0600` on every write.
- Regression: a real project-scoped Claude Code install starts with a `0775` project root, writes and verifies `.mcp.json`, and leaves the project root at `0775`.
- Focused verification: the client-config TypeScript build passed. All 28 client-config tests and all 4 packaged client-install contract tests passed. `git diff --check` passed.
- Remaining gate: the complete desktop suite and integrated repository check must pass before this row becomes `VERIFIED`.

### 13: target-bound desktop builder environment

- Root cause: payload preparation selected a target, but the later electron-builder process reconstructed the payload platform from its host unless an environment value happened to exist.
- Repair: one checked target helper derives the builder platform from the selected target record. Every package invocation passes that value with the exact prepared payload and output directory.
- Regression: the helper maps `darwin-arm64` to `darwin`, maps `win32-x64` to `win32`, and refuses an unconfigured target.
- Focused verification: package-script syntax passed. All 15 desktop-target and electron-builder configuration tests passed, and `git diff --check` passed.
- Remaining gate: a native Windows package build and the integrated repository check must pass before this row becomes `VERIFIED`.

### 14: bounded per-page approval grants

- Root cause: the approval server stored one nonce by operation and used one cookie name by operation path. Every review GET replaced both values. A stale form failure then deleted the replacement grant as well.
- Repair: every rendered review page receives an independent one-use nonce and a nonce-specific HttpOnly cookie. Grants bind to the exact operation or batch. Expired grants are pruned, each target is capped at eight pages, and the server is capped at 128 grants. Invalid input can remove only its own expired grant. A successful approve or cancel revokes every remaining grant for that exact target before the controller transition.
- Regression: the first tab approves successfully after a second tab opens. A first-tab form paired with the second tab's cookie is refused and leaves the second grant valid; the second tab then approves exactly once.
- Focused verification: the Gateway TypeScript build passed. All 9 approval-page and maintenance-admission tests passed, and `git diff --check` passed.
- Remaining gate: the complete Gateway and integrated repository checks must pass before this row becomes `VERIFIED`.

### 15: one complete Private Chat dialog lifecycle

- Root cause: the drawer declared `aria-modal="true"` but changed only its visibility and body overflow. The covered Settings page remained in the browser focus order, and keyboard navigation could reach permission controls behind the scrim.
- Repair: opening the drawer now makes the exact background `main` element inert, publishes `aria-expanded`, records the invoking control, and focuses the close button. One live focus trap recomputes the enabled dialog controls for each Tab press. Escape and every close path remove inertness, clear the local conversation, and restore the recorded focus.
- Regression: the DOM test proves inertness, both Tab boundaries, expanded state, and exact focus restoration. The Chrome for Testing campaign proves the same behavior in the shipped extension with only one enabled dialog control.
- Focused verification: the 29-test Settings and Private Chat gate passed. The complete Chrome for Testing connector campaign passed. Direct inspection of the light and dark rendered captures found no clipped, hidden, or unreadable dialog content.
- Remaining gate: the integrated repository check must pass before this row becomes `VERIFIED`.

### 124: canonical capability access classification

- Root cause: catalog construction derived read routing from MCP annotations, then let independent source capability metadata overwrite the descriptor's read-only, mutating, and destructive fields. Runtime effect admission still trusted the annotation alone.
- Repair: catalog admission now derives one access classification from normalized annotations. Any supplied behavior classification must match it. A mutating tool cannot use approval class `none`, claim read-only-profile support, or disagree with destructive approval. The final descriptor writes the canonical fields after source metadata. Valid read-only planning tools may still describe the approval class of their future reviewed effect.
- Regression: table-driven tests refuse forged read/write behavior, a missing read annotation, no-approval mutation metadata, destructive mismatch, and read-only-profile mutation support. A consistent grade mutation retains the same access facts in annotations and capability metadata.
- Focused verification: the Gateway Core build and all 25 catalog, reconciliation, publication, and publication-candidate tests passed. The Blackboard package build, 37 focused Blackboard tests, all 6 real Blackboard surface tests, and all 17 Canvas connector integrations passed.
- Remaining gate: the integrated repository check must pass before this row becomes `VERIFIED`.

### 105: generation-bound pairing authority

- Root cause: pairing status checks read the current pairing before network I/O, then wrote an approved token outside the shared storage queue. Disconnect could clear storage while that request was in flight, after which the stale poll restored the token and reconnected.
- Repair: every pairing attempt now owns a durable random generation and one authority record. Request creation, approval, denial, expiry, and user disconnect change that record through the same serialized storage queue. Approval commits the token, cleared pairing, and terminal authority together only when the exact generation is still pending. Disconnect aborts every pairing fetch, writes a new disconnected tombstone before cleanup, and keeps that tombstone after the other connection fields are removed.
- Regression: a real service-worker harness holds an approved status response, completes Disconnect, confirms the request signal was aborted and the generation changed, then releases the stale approval. The old response creates no token, pairing, socket, or authority change.
- Focused verification: service-worker syntax passed. All 35 pairing, consent, Settings, and Private Chat tests passed. The complete Chrome for Testing connector campaign passed, including live pairing, extension restart, and final disconnect cleanup.
- Remaining gate: the integrated repository check must pass before this row becomes `VERIFIED`.

### 106: session-owned Canvas list continuation authority

- Root cause: the page executor encoded its next URL and cumulative page count in an unsigned base64 value supplied by the caller. A caller could lower the count or mint another same-route value and restart the 500-page cumulative budget.
- Repair: the service worker now owns one-use random continuation records in `chrome.storage.session`. Each record binds the source binding, origin, course, principal, LMS session generation, Bridge generation, operation, normalized semantic arguments, canonical next URL, cumulative page count, creation time, and expiry. Claim deletes the record before provider access. Issuance validates same-origin HTTPS continuation URLs, caps the store at 128 records, and expires every record after five minutes. Disconnect clears the store, and a new Bridge generation makes every earlier record unusable. The content page receives private claimed state and cannot decode caller input.
- Regression: focused tests refuse a caller-created same-route value and a replayed one-use token. The real Chrome campaign completes a capped list with the issued token, then proves both token replay and a caller-forged token fail with `canvas_pagination_resume_refused` before provider access.
- Focused verification: service-worker and content-script syntax passed. All 14 focused continuation and pairing tests passed. The complete Chrome for Testing connector campaign passed.
- Remaining gate: the integrated repository check must pass before this row becomes `VERIFIED`.

### 125: effect-bound provider cancellation

- Root cause: the public MCP abort signal stopped at the Gateway boundary. Mutation planning, journal dispatch, source transport, Canvas connector runtime, Bridge protocol, and extension execution each used an independent lifecycle. The extension also had no durable distinction between a queued command and a provider request that may already have started.
- Repair: one signal now follows the exact operation through planning, authority checks, dispatch reservation, source execution, connector runtime, and Bridge invocation. Pre-aborted planning creates no operation. An approved unsent operation settles as cancelled. The effect broker can atomically settle a reserved dispatch as `cancelled_before_dispatch`. The Bridge sends an exact cancellation envelope and waits for a bounded extension acknowledgement. The extension owns one generation-bound command record, marks the provider-effect boundary immediately before execution, returns `request_cancelled_before_dispatch` before that boundary, returns `write_outcome_unknown` after it, and suppresses duplicate or late results.
- Regression: unit and integration tests prove cancellation before planning creates no journal row, cancellation before explicit dispatch leaves zero attempts, cancellation after dispatch reservation settles the correct terminal state, exact Bridge identity clears only the matching request, and a potentially sent source result remains uncertain. The real Chrome campaign queues two page changes behind a held provider request. Cancelling the queued change sends nothing to Canvas. Cancelling the held change after Canvas receives it reports an unknown outcome; the later provider success cannot replace that result.
- Focused verification: all 21 operation-journal tests, 20 Bridge loopback tests, 22 Canvas connector runtime/server tests, 8 Gateway operation integration tests, and 8 extension cancellation and Private Chat tests passed. The complete Chrome for Testing connector campaign passed with the two real cancellation boundaries. `git diff --check` passed.
- Remaining gate: the integrated repository check must pass before this row becomes `VERIFIED`.

### 104: mutually authenticated Bridge handshake

- Root cause: the extension sent its reusable bearer token and current course bindings as the first WebSocket frame. The loopback server authenticated the extension only after receiving that frame. The extension accepted `ready`, commands, and close code 4403 from any process that held the fixed local port. A local impostor could therefore capture authority, issue commands, or erase saved connection state without proving it was Morrow.
- Repair: the first frame is now a secret-free authentication request with a fresh 32-byte client nonce and public build identity. The Bridge answers with its own fresh 32-byte nonce and an HMAC-SHA-256 server proof bound to both nonces, the protocol path, extension identity, runtime revision, and catalog digest. The extension compares that proof before it sends its HMAC client proof or any bindings. The token never crosses the WebSocket. The extension accepts `ready` and later frames only in the authenticated connection phase. A pre-authentication close cannot erase saved authority. A proven identity mismatch exposes an explicit Reconnect Morrow flow that preserves selected courses and replaces the token only after a new reviewed pairing.
- Regression: the loopback test proves the first client frame has no token or bindings, validates the server proof, and rejects a forged client proof without activating a connection. The service-worker adversarial test gives the extension a forged server proof and proves it sends no hello, retains its token, and executes no command. Gateway tests reject wrong build identity and wrong token proofs within their deadline. The real Chrome campaign pairs, restarts the extension, executes concurrent reads and writes, rotates the Bridge token, renders the retained-course reconnect state, re-pairs, reconnects, and disconnects cleanly.
- Focused verification: the complete 18-test protocol contract and 19-test loopback server gates passed. The complete protocol gate passed all 18 Gateway and runtime integration tests. All 46 Canvas connector tests and 5 legacy connector tests passed. The 17-test extension authentication, consent, legacy-overlay, and popup gate passed. The complete Chrome for Testing connector campaign passed. Direct inspection of the 360-pixel light and dark reconnect captures found no clipping, ambiguity, or unreadable content. The full workspace build and `git diff --check` passed.
- Remaining gate: the integrated repository check and final packaged Bridge inspection must pass before this row becomes `VERIFIED`.

### 126: complete durable operation discovery

- Root cause: the broker exposed only a fixed recent window and the Gateway derived global health from that same truncated list. Once 200 newer records existed, an older uncertain provider effect disappeared from review and from the unresolved count.
- Repair: the broker now owns canonical opaque keyset cursors over its durable `created_at DESC, operation_id DESC` order. Each page returns at most 200 operations, one-use traversal state is unnecessary, and every valid cursor reaches the next older row without offset drift. A separate SQLite aggregate computes total, unresolved, uncertain, and dispatching counts across the complete journal. The public operation tool returns the total counts, page state, and next cursor. Invalid and non-canonical cursors fail closed.
- Regression: one oldest unresolved provider effect remains discoverable after 205 newer cancelled effects. The journal and Gateway tests traverse all 206 unique records, report exactly one unresolved operation, expose incomplete recent-window coverage, terminate with a null cursor, and reject an empty or malformed cursor.
- Focused verification: the operation-journal TypeScript build and all 22 journal tests passed. The Gateway TypeScript build, both native-tool manifest tests, and all 9 operation integration tests passed.
- Remaining gate: the complete Gateway and integrated repository checks must pass before this row becomes `VERIFIED`.

### 115: one Chrome extension version contract

- Root cause: packaging used a private regular expression that accepted prerelease text in the fourth component. Installation used Chrome's numeric one-to-four-component contract with safe 16-bit component values. A package could therefore pass release construction and fail only on the person's machine.
- Repair: the packager now calls the exact exported installer parser. Packaging and installation share one validation implementation for syntax, component count, leading zeros, integer safety, and the 65535 component maximum.
- Regression: packaging rejects a prerelease suffix, five components, a leading zero, and a component above 65535. It accepts a valid four-component Chrome version. The complete Bridge update tests still accept and compare ordinary installed versions.
- Focused verification: package-script syntax passed. All 6 Bridge release and desktop provenance tests passed. All 17 Bridge update and adversarial installation tests passed.
- Remaining gate: the integrated repository check and final packaged Bridge inspection must pass before this row becomes `VERIFIED`.

### 121: canonical desktop update feed identity

- Root cause: the builder, runtime fallback, tests, and maintainer guide each copied the update feed identity. The guide named the source repository while the executable and workflow used the separate download repository.
- Repair: `installer/shared/update-feed.cjs` now owns the feed ID, provider, owner, repository, and channel. The builder derives both signed metadata and its publish target from that record. The desktop runtime imports the same record for fail-closed metadata comparison. The guide names the canonical `bradenriggins/morrow-downloads` feed.
- Regression: the builder test reads the canonical record, compares the publish configuration and embedded runtime metadata field for field, requires the same repository in the maintainer guide, and rejects the old repository name.
- Focused verification: source syntax passed. All 12 electron-builder configuration tests and all 22 desktop documentation and release-workflow tests passed.
- Remaining gate: the complete desktop and integrated repository checks must pass before this row becomes `VERIFIED`.

### 122: atomic verified runtime archive cache

- Root cause: the packager wrote the network response directly to the shared final cache path and verified it afterward. An interrupted response left that path present. Every later run skipped the download and failed on the same partial bytes.
- Repair: downloads now stream to a unique process-owned partial file. The complete partial file must match the pinned SHA-256 before an atomic rename publishes it. A corrupt existing entry is removed before retry. Concurrent packagers keep an already published verified file and discard their duplicate partial file. Every failure removes its partial file.
- Regression: the cache starts with poisoned bytes, receives a stream that fails after eight bytes, and ends with neither a final entry nor a partial file. A later complete response publishes the exact verified bytes, leaving one canonical cache entry.
- Focused verification: package-script syntax passed. All 4 desktop payload provenance tests passed, including a real payload preparation from the repaired cache path.
- Remaining gate: the complete packaging and integrated repository checks must pass before this row becomes `VERIFIED`.

### 123: owned native smoke state lifecycle

- Root cause: each native smoke harness created a private application-state root before the first launch and never placed that root inside a cleanup owner. Windows also kept its dedicated empty installation directory when a later assertion or uninstall step failed.
- Repair: one shared `withTemporaryDirectory` owner now removes application state after both resolved and rejected smoke bodies. Cleanup failure is surfaced, and a body failure plus cleanup failure remains an aggregate failure. The Windows harness also removes its dedicated installation directory in a final boundary. New harness receipts are emitted only after cleanup succeeds and record that state and installation cleanup completed.
- Regression: the shared owner writes real state and proves the directory is absent after success and after a synthetic failure. Both native harnesses pass syntax and contract checks. The final Windows evidence gate now requires the v3 cleanup receipt fields, so old v2 evidence cannot claim the repaired lifecycle.
- Focused verification: all 47 temporary-directory and native smoke contract tests passed. All 13 release-workflow and zero-tolerance receipt tests passed.
- Remaining gate: native macOS and Windows harness runs must create fresh cleanup-aware receipts before final release verification.

### 117: smoke the retained macOS artifact

- Root cause: the macOS job retained and uploaded the DMG but extracted and ran the sibling ZIP. A broken DMG could therefore leave the workflow green and become the only distributed artifact.
- Repair: the workflow now exports the exact DMG path, mounts that image read-only with `hdiutil`, verifies that it contains `Morrow.app`, and runs the native smoke harness directly against the mounted application. A trap detaches the image and removes the mount directory on every exit path. The ZIP is still required as a packaging output, but it is no longer substituted as release evidence for the DMG.
- Regression: the workflow contract requires the DMG environment binding, read-only mount, mounted application path, detach path, retained receipt directory, and absence of the former ZIP extraction route. Every embedded macOS shell body passes `bash -n`.
- Focused verification: all 22 desktop documentation and release-workflow tests passed.
- Remaining gate: a native macOS workflow run must mount and smoke the newly built DMG before this row becomes `VERIFIED`.

### 119: proven unsigned Windows artifacts

- Root cause: an unsigned package request set `MORROW_SIGNED_RELEASE=0` but inherited the caller's complete environment. Electron-builder discovers Windows certificates from `WIN_CSC_LINK` or `CSC_LINK`, so it could sign the installer while the Morrow receipt still declared an unsigned mode.
- Repair: unsigned packaging removes every electron-builder certificate, keychain, Azure identity, Apple signing, and publishing credential before the builder starts. It also sets `win.sign=false` in unsigned builder configuration. After build, Morrow parses the produced PE security directory and refuses to write or publish an unsigned receipt when an Authenticode certificate table exists. A Windows receipt now records `artifactSignature: authenticode_absent` only after that byte-level check.
- Regression: the environment test starts with local, Windows, Azure, and publishing authority and proves each field is absent from the builder environment. Synthetic valid PE32+ files prove an empty certificate table is accepted and a present certificate table is rejected. Builder tests require explicit disabled signing for unsigned builds and no disabled-signing field for a signed build.
- Focused verification: all 5 desktop provenance tests and all 12 electron-builder configuration tests passed.
- Remaining gate: a native Windows package run must produce a fresh `authenticode_absent` receipt before this row becomes `VERIFIED`.

### 120: evidence-gated Bridge delivery selection

- Root cause: `MORROW_CHROME_STORE_LIVE=1` changed shipped setup instructions from ambient process state. The package receipt did not disclose that change, and no Store listing or exact extension publication proof was required.
- Repair: `installer/shared/bridge-delivery.cjs` now owns the only currently admissible packaged route, `developer_temporary`. The builder and package receipt consume that exact value. The packager removes the former environment variable before starting electron-builder. The deployment guide states that a Store route requires a new verified publication and receipt contract before it can be exposed.
- Regression: builder tests try every prior environment value, including `1`, and prove none can change the packaged route. The unsigned environment regression proves the old selector does not reach the builder. Desktop documentation checks pass with the updated contract.
- Focused verification: all 5 desktop provenance tests and all 34 builder, documentation, and release-workflow tests passed.
- Remaining gate: the final package receipt and application metadata must be inspected together before this row becomes `VERIFIED`.

### 116: source-fresh desktop executable builds

- Root cause: payload capture copied each ignored workspace `dist` tree exactly as it existed. The source checkpoint covered Git state but ignored compiled output, and the package command did not build. A clean tracked checkout could therefore seal old or manually changed JavaScript under the current commit identity.
- Repair: desktop payload preparation now deletes every known workspace `dist` tree and runs the complete workspace build before it reads any release bytes. Every package must produce a nonempty regular-file output tree. The tracked HEAD, dirty bit, and status digest must remain identical across the rebuild and again across sealed-input capture. Any concurrent tracked-source change aborts packaging.
- Regression: all 13 workspace packages start with an ignored stale executable. The release rebuild proves each stale file is gone before its build callback runs and that every captured output comes from the new build. A real payload preparation runs the full rebuild and still proves its sealed input and runtime provenance.
- Focused verification: package-script syntax passed. All 6 desktop provenance tests passed, including a real full workspace rebuild and payload preparation.
- Remaining gate: the final desktop packaging gate must inspect the new receipt and installed payload before this row becomes `VERIFIED`.

### 118: exact complete CycloneDX runtime graph

- Root cause: the SBOM copied manifest ranges for direct dependencies, merged different versions by package name, included development declarations, and never traversed the lockfile snapshot graph. It also ignored the desktop installer's separate manifest and lockfile.
- Repair: the generator now parses each staged pnpm v9 lockfile and binds every staged manifest to its exact importer. It resolves production and optional dependencies to exact snapshot keys, preserves parallel versions, traverses every transitive dependency, and emits a dependency row for every component. The private candidate includes the installer's independent runtime graph. Missing importers, ambiguous snapshot identities, unstaged workspace dependencies, and unsupported lockfile versions fail closed.
- Regression: a root manifest declares a range, a development-only package, and a production dependency with one transitive child. The SBOM emits only the exact locked production versions and the complete two-edge graph. A full working-tree graph contains 115 exact components and 115 dependency rows, includes the installer and `eventsource-parser`, and has no ranges or dangling references.
- Focused verification: release-candidate syntax passed. All 13 release-gate tests passed, including deterministic two-profile candidate generation. The full working-tree SBOM graph inspection passed.
- Remaining gate: deterministic rebuild and final candidate scans must run again after the complete repair wave before this row becomes `VERIFIED`.

### 111: one bounded desktop child lifecycle

- Root cause: assistant detection and installer configuration used two child-process implementations. The configuration runner accumulated every output chunk before truncation and sent only one soft termination signal at its deadline. The detection runner limited bytes but returned immediately after one soft signal, so its child and pipes could remain alive.
- Repair: both routes now use one bounded command owner. It retains at most 128 KiB across standard output and standard error, treats excess output as a terminal condition, gives every command a finite deadline, escalates from `SIGTERM` to `SIGKILL`, and releases its pipes after a fixed final close deadline. POSIX commands run in their own process group, so descendants receive the same termination. The result records the exact terminal reason.
- Regression: a child that continuously writes 64 KiB blocks is terminated after exactly 4 KiB is retained. A second child installs a `SIGTERM` handler and stays alive; the runner escalates, settles within two seconds, and the process ID no longer exists.
- Focused verification: installer-controller syntax passed. All 38 installer-controller tests passed, including the existing slow, excessive-output, missing-command, and nonzero detection cases.
- Remaining gate: the complete desktop and integrated repository checks must pass before this row becomes `VERIFIED`.

### 107: window-first automatic update startup

- Root cause: desktop startup awaited the complete update controller start before it registered IPC or created the window. That start reconciles durable update state and can enter release-host discovery and automatic download work. A slow or stalled external request therefore held the whole local desktop surface closed.
- Repair: Morrow now completes local Bridge initialization, registers every IPC handler, loads the sandboxed window, and attaches the update-state subscriber before it starts optional update work in a detached promise. A rejected update start is contained inside that background owner and cannot become an unhandled rejection.
- Regression: the real main-process startup is injected with an update controller whose `start()` never resolves. Startup still loads the exact renderer file, creates the window, and registers every IPC handler within one second while the update request remains blocked.
- Focused verification: main, preload, and renderer syntax passed. All 57 contract, renderer, and adversarial desktop tests passed with one Windows-only access-control skip.
- Remaining gate: the complete desktop and integrated repository checks must pass before this row becomes `VERIFIED`.

### 109: live accessible update delivery

- Root cause: the update controller already published state changes, but the main process never subscribed. The renderer learned update state only as a side effect of a manual action, focus refresh, or unrelated setup read. The update text also had no live-region semantics.
- Repair: main now forwards each controller snapshot over one fixed receive-only channel while its window is alive. The isolated preload exposes one typed subscription with exact listener removal. The renderer validates the complete public snapshot shape, updates only the update panel, preserves control focus, and reapplies busy-state disabling. The status text is an atomic polite live region.
- Regression: the real main and preload deliver a ready snapshot over the same fixed channel and remove its listener exactly. The renderer receives a background ready state, adds the restart action without another IPC state request, and ignores a malformed event. The markup test proves the status, live, and atomic accessibility attributes.
- Focused verification: main, preload, and renderer syntax passed. All 57 contract, renderer, and adversarial desktop tests passed with one Windows-only access-control skip.
- Remaining gate: rendered desktop inspection plus the complete desktop and integrated repository checks must pass before this row becomes `VERIFIED`.

### 112: awaited normal desktop shutdown

- Root cause: Electron's `before-quit` listener stopped update timers and launched runtime cleanup with `void`. Electron continued exiting while the monitor could still own its stdio child or a maintenance lease. Concurrent cleanup calls also observed the monitor as absent as soon as the first caller started closing it.
- Repair: one quit coordinator prevents the first quit, owns exactly one cleanup promise, removes the update subscriber, stops update scheduling, and awaits runtime close before it issues the final allowed quit. Installer runtime close is now one shared transaction. All concurrent callers await it, lease references remain owned until the close finishes, and a replacement monitor waits for an active close.
- Regression: two quit events during a held cleanup both stop exit but start cleanup once. The app does not receive its final quit until the cleanup gate resolves, and the deliberate continuation is allowed. Two concurrent installer closes call the monitor once and clear lease references only after that close finishes.
- Focused verification: main and installer-controller syntax passed. All 64 main lifecycle, installer-controller, and desktop contract tests passed.
- Remaining gate: the complete desktop and integrated repository checks must pass before this row becomes `VERIFIED`.

### 113: transactional Bridge maintenance ownership

- Root cause: stale-file recovery checked a JSON lock, deleted its path, and created a replacement in separate filesystem operations. Two contenders could both approve the stale observation. One could delete or replace the path while the other already believed it held ownership. Final cleanup also removed the path without binding it to the owner's exact generation.
- Repair: the Bridge state directory now contains one strict SQLite lock row. `BEGIN IMMEDIATE` serializes creation, stale takeover, and exact generation-bound release. The row binds a random lock ID, process ID, and start time. A live or young owner fails closed. An older JSON lock remains a migration barrier: the database owner removes it only after it proves that legacy process is dead and the stale window elapsed.
- Regression: an update held during provider quiescence refuses a concurrent challenge. A second test seeds one stale database row and starts two challenge contenders together. Exactly one acquires and writes its challenge, the other receives `bridge_update_busy`, the installed record matches the sole winner, and the authority table is empty after exact release.
- Focused verification: Bridge update source syntax passed. All 9 Bridge update and adversarial maintenance tests passed.
- Remaining gate: the complete desktop and integrated repository checks must pass before this row becomes `VERIFIED`.

### 114: release-bound same-version Bridge replacement

- Root cause: every Bridge decision reduced release identity to Chrome's manifest version. Reconciliation returned early when the versions were equal, low-level update preparation rejected equality, and repair replaced only an older version. A desktop release could therefore carry verified changed extension bytes that no existing installation could receive.
- Repair: installation status now carries the sealed release-manifest digest. Reconciliation treats equal version plus equal digest as unchanged, but sends equal version plus changed digest through the same quiesce, staged swap, rollback, new active-folder challenge, manual Chrome reload, exact readback, and confirmation transaction used by a newer version. Repair also compares the digest and rebuilds changed same-version bytes from the sealed payload.
- Regression: a same-version service worker with a second release revision stages only after exact quiescence, keeps the original bytes as rollback, requires the new active-folder proof, confirms, and deletes the rollback. An identical same-version receipt remains refused. Controller reconciliation stages once only after its digest changes. Full repair replaces same-version bytes and records the new exact release digest and challenge.
- Focused verification: Bridge update and installer-controller syntax passed. All 10 Bridge update tests and all 41 installer-controller tests passed.
- Remaining gate: the complete Chrome Bridge campaign, desktop suite, and integrated repository check must pass before this row becomes `VERIFIED`.

### 108: one authoritative desktop mutation transaction

- Root cause: desktop IPC mutation routes relied on a local admission snapshot. They did not acquire durable owner authority, and each route implemented a different subset of runtime shutdown, serialization, and release. A repair, configuration change, assistant mutation, or startup Bridge write could therefore overlap another process that still owned the same state.
- Repair: one controller-owned mutation transaction now serializes every public desktop write. It binds the exact local-owner journal and workspace, acquires the live owner's maintenance lease or proves a stopped runtime through the exclusive journal lock, commits owner shutdown before runtime-sensitive writes, rotates authority into a stopped guard without an unowned interval, and releases only its exact secret. Workspace, Blackboard, assistant, repair, and startup Bridge writes use this transaction. Bridge initialization can retry after a failed attempt. A failed release retains the guard and blocks later mutation.
- Regression: an exact trace proves live-owner acquisition, commit, monitor close, stopped-guard rotation, mutation, and release in order. A route table proves that refused admission leaves workspace, Blackboard, assistant, installer-record, and CLI targets unchanged. A concurrent second mutation is refused while the first is still acquiring authority.
- Focused verification: controller and combined assistant/adversarial tests passed. The complete desktop suite passed all 315 tests: 314 passed, one Windows-only skip, and zero failures.
- Remaining gate: the integrated repository checks must pass before this row becomes `VERIFIED`.

### 110: process-lifetime-bound durable authority

- Root cause: durable locks and session records treated a numeric process ID as a process identity. Operating systems reuse those numbers. A later unrelated process could therefore preserve a dead owner descriptor, proxy session, maintenance marker, runtime lease, Blackboard transaction lock, or Bridge update lock as live.
- Repair: shared process-lifetime probes now read the operating-system process start time on macOS, Linux, and Windows. Legacy records require the current process to have started before the record. Current Bridge and Blackboard locks store the exact process start time and require an exact match. An unavailable identity probe fails closed. Owner startup, session reaping, runtime and maintenance recovery, desktop recovery, Claude connection status, Bridge lock takeover, and Blackboard transaction takeover all use the lifetime-bound decision.
- Regression: pure boundary tests reject a process that started after its record and retain an unknown answer. Runtime and maintenance tests reclaim a record whose numeric PID is live but whose recorded process is dead. A Bridge database lock held by the exact current process blocks takeover, while the same PID with a different recorded start time is reclaimed. Blackboard reclaims the same reused-PID fixture. Existing cross-process exclusion, stale-owner recovery, owner integration, Claude lifecycle, Bridge update, and desktop controller behavior remains green.
- Focused verification: Gateway core, Blackboard, and Gateway builds passed. All 20 owner, maintenance, and runtime-lease tests passed. All 14 Blackboard effect-record tests passed. All 67 Bridge update, Claude Desktop, and installer-controller tests passed. Source syntax and `git diff --check` passed for the repaired paths.
- Remaining gate: the complete Gateway, desktop, and integrated repository checks must pass before this row becomes `VERIFIED`.

### 38, 39, and 46: process-bound dual-era connection lifecycle

- Root cause: three layers treated an allocated transport object as proof of a live connection. The desktop monitor retained its client after a failed health request. The stdio proxy closed its transport after owner failure but did not terminate. The proxy also forwarded modern `server/discover` traffic into a stateful legacy HTTP session that rejects all pre-initialize methods.
- Repair: a failed monitor request now disconnects both client and transport, and the same refresh reconnects immediately. A fatal owner-proxy error closes both sides and terminates the proxy with a nonzero status. The owner now uses the SDK's dual-era composition: stateful HTTP sessions serve legacy clients, while the documented per-request handler serves modern envelope traffic from the same Morrow server factory. Modern client presence is bound to the exact proxy PID, workspace, and process start boundary. It participates in idle shutdown, dead-client reaping, and maintenance exclusion. Shutdown closes modern streams before the HTTP socket.
- Regression: the monitor fixture completes one status read, exits its stdio process, and proves the next ordinary refresh starts a new process and returns verified state. One shared-owner test connects a legacy and pinned `2026-07-28` client to the same runtime, proves both can call it, stops the owner, proves the surviving proxy request settles as an error, and proves the proxy process terminates.
- Focused verification: Gateway built successfully. All 25 local-owner, maintenance, and dual-era protocol tests passed. All nine desktop runtime-monitor tests passed. Source syntax and focused diff checks passed.
- Remaining gate: the complete Gateway, desktop, and integrated repository checks must pass before these rows become `VERIFIED`.

### 21, 22, and 24: one typed, indexed learner projection

- Root cause: privacy projection inferred identity from raw-value overlap. An arbitrary `{ id, name }` became a learner when its ID happened to match the roster. Whole numeric strings became learners without considering resource or measure fields. Each string then cloned and tokenized the complete roster, rebuilt a full alias expression, and rechecked freshness. Label allocation also rescanned every existing label.
- Repair: one immutable exact-scope projection context now owns a single freshness check, roster snapshot, ID index, token index, alias index, and compiled matcher. Object classification requires an identity container or identity-specific fields; roster overlap supplies no type evidence. One scalar policy protects numeric and string resource IDs and measures, including a typed `{ kind: "page", id }` target. Learner records still require and validate exact roster identity. The vault allocates labels in constant amortized time and persists a batch of new labels once.
- Regression: an assignment and page whose ID equals learner 17 remain exact resources; assignment, Quiz, page, target, and score string fields stay `"17"`; a person ID field still becomes `Student A1`. A 2,500-record learner projection returns all records in about 0.6 seconds with exactly one roster read and one readiness check.
- Focused verification: Gateway core built successfully. All 39 privacy tests passed, including the full identity, encoding, artifact, scope, persistence, collision, and large-result cases. A separate 10,000-identity boundary probe completed and returned the exact final learner label.
- Remaining gate: the complete Gateway core, Gateway, and integrated repository checks must pass before these rows become `VERIFIED`.

### 23 and 127: evidence-bound numeric aliases and stable leak scanning

- Root cause: Private Chat put every numeric roster value into its general prose alias replacement. A score equal to any learner ID therefore became a learner label. The final leak scan then deleted valid protected labels, which could join an identity prefix such as `student #` to the next prose word and falsely report that word as an unknown ID.
- Repair: numeric aliases are replaced only when the request explicitly asserts that exact alias or when a person-specific field or textual context identifies the number. Ordinary numeric facts remain unchanged. The final scan replaces approved labels with a non-identifier placeholder, so removing privacy evidence cannot change the grammar of surrounding text.
- Regression: `Michaela Brook scored 42 out of 50; student #7 needs review` becomes `Student A1 scored 42 out of 50; student #Student A1 needs review`. An explicitly asserted learner 42 still becomes `Student A2`. The phrase after the protected label no longer causes a false unknown-identifier refusal.
- Focused verification: protected-request syntax passed. All nine Private Chat tests passed.
- Remaining gate: the complete extension and integrated repository checks must pass before these rows become `VERIFIED`.

### 42: comment-preserving external JSON configuration

- Root cause: Morrow treated every assistant JSON file as strict JSON even when the owning clients accept comment-bearing configuration. Its structural editor also tokenized comments as values and could add a second comma after an accepted trailing comma.
- Repair: one offset-preserving JSON-with-comments preparation path now validates line comments, block comments, and trailing commas without changing source positions. The structural tokenizer skips both comment forms and records whether an object already has a trailing comma. Morrow therefore edits only its exact member and preserves every unrelated byte. Unterminated comments remain a hard refusal.
- Regression: real VS Code and Gemini fixture files carry line comments, block comments, comments after members, and trailing commas. Morrow adds its entry, preserves every comment, and recognizes the unchanged result on a second install. An unterminated block comment is refused without a write.
- Focused verification: the client-config build passed. All three focused merge, formatting, and comment-preservation tests passed.
- Remaining gate: the complete client-config and integrated repository checks must pass before this row becomes `VERIFIED`.

### 43: parser-owned Codex TOML removal identity

- Root cause: installation parsed TOML key identity, while desktop removal searched for one literal `[mcp_servers.morrow]` line. Equivalent quoted or escaped keys remained active after the installer removed its record.
- Repair: the parser-backed client-config package now owns Codex table removal. It resolves each table header through the TOML parser and recognizes the exact `mcp_servers.morrow` path across bare, quoted, escaped, and whitespace-bearing forms. The desktop installer calls that same implementation and reads the saved file back through it before it removes the assistant record.
- Regression: the parser unit test removes bare, double-quoted, single-quoted, Unicode-escaped, and spaced headers and refuses a later unrelated table that the append-only installer did not create. The desktop integration removes a quoted table and proves the installer record is empty only after readback.
- Focused verification: the client-config build passed. All three focused TOML tests passed. All 21 assistant-management tests passed.
- Remaining gate: the complete client-config, desktop, and integrated repository checks must pass before this row becomes `VERIFIED`.

### 44: digest-bound multi-client rollback ownership

- Root cause: the original rollback restored a captured file without proving Morrow's own replacement was still the current generation. A later process could edit an earlier assistant while setup failed on a later assistant, and rollback could erase that edit.
- Repair: every staged assistant change carries the digest of the complete bytes Morrow wrote. Reverse-order rollback restores its capture only while the current file still has that exact digest. All assistant writes and verifications complete before the workspace record commits.
- Regression: one test changes the target before Morrow writes and proves it is neither replaced nor rolled back. Another changes an earlier successfully rebound assistant while a later assistant is in progress, then proves the later failure does not commit the workspace and does not erase the concurrent edit. The lower-level capture test proves a matching generation restores and a newer generation survives.
- Focused verification: all four focused rollback and concurrent-edit tests passed. The complete 21-test assistant-management file also passed.
- Remaining gate: the complete desktop and integrated repository checks must pass before this row becomes `VERIFIED`.

### 67: observational desktop state after data removal

- Root cause: `effectiveWorkspace()` was both a query and a creator. A successful removal set only an in-memory flag. A new desktop process lost that flag, and its first state read recreated the default Materials folder.
- Repair: workspace reads are now observational. Only an explicit assistant-setup transaction may create the default Materials folder. A first setup still works without a separate folder-selection step, while process start, state refresh, runtime discovery, and retention inspection create no materials.
- Regression: the removal test deletes every listed path and keeps Materials absent. A new controller process then reads complete desktop state, reports `ready_for_workspace`, reports no materials path, and leaves the folder absent. First-time assistant setup still creates and binds the default folder.
- Focused verification: all four focused workspace, removal, relaunch, and first-setup tests passed.
- Remaining gate: the complete desktop and integrated repository checks must pass before this row becomes `VERIFIED`.

### 88: generation-atomic client bundle publication

- Root cause: bundle rendering prepared and renamed each destination independently. A later file restriction or write failure left earlier files from the new render beside later files from the old render.
- Repair: Morrow now creates and restricts the complete bundle in a unique sibling staging directory. It publishes the directory only after every file is complete. Replacement first preserves the prior complete directory, restores it if publication fails, and removes it after the new generation commits. `force` refuses any destination with files outside Morrow's exact bundle inventory.
- Regression: an injected Windows restriction failure on the fourth staged file leaves every file in the prior generation byte-for-byte unchanged and leaves no staging directory. A later successful forced render replaces every file with the new generation and changes the manifest as one set.
- Focused verification: the client-config build and focused bundle publication test passed. `git diff --check` passed for the changed client-config files.
- Remaining gate: the complete client-config and integrated repository checks must pass before this row becomes `VERIFIED`.

### 25, 26, 27, and 78: complete program evidence identity

- Root cause: the program workflow carried partial identities across four boundaries. Inventory admission treated a provider-local course ID as global. Course audit reports normalized a returned item but did not retain the exact selected target. The ledger compared only course and kind, and its artifact resolver omitted the caller audience. The ledger also copied four signal names instead of consuming the producer's complete signal contract.
- Repair: selected-course identity is now the composite of provider, source binding, and course ID. Every course audit report retains its exact selected target. The ledger validates provider, source binding, course, target kind, and complete selected target for both the audit and re-audit before deriving any state. The course-audit producer exports its 18-field signal contract, and the ledger consumes that exact contract at every nested evidence level. Missing, unknown, truncated, or traversal-bounded signal evidence cannot produce a zero-signal repair result. One shared artifact-audience function now binds both public paging and ledger resolution to the exact MCP session and client.
- Regression: two Canvas or Moodle sites may each select their own course 42, while an exact repeated connection is refused. Swapped same-kind targets, another connection, another course, and a foreign repair re-audit are refused. Every current signal category independently prevents a zero-signal result, and incomplete signal coverage cannot become `repaired_and_verified`. A large saved inventory resolves for its bound audience and fails for another audience.
- Focused verification: the Gateway TypeScript build passed. All 47 program-ledger, course-inventory, and course-audit tests passed. `git diff --check` passed for the changed Gateway paths.
- Remaining gate: the complete Gateway and integrated repository checks must pass before these rows become `VERIFIED`.

### 33: format-field-owned Moodle course settings

- Root cause: `format_options` treated every writable form control as a course-format option. Protected category, visibility, and summary controls therefore crossed the operation's stated boundary.
- Repair: the executor derives its allowlist from the exact current Course format fieldset and refuses every requested option outside that set before it submits the form.
- Regression: category, visibility, and summary-editor requests produce no POST and preserve their protected values. A real format option still writes and verifies normally.
- Focused verification: source syntax passed. Both Moodle course-settings and Lesson test files passed all 5 tests. The focused diff check passed.
- Remaining gate: the complete extension and integrated repository checks must pass before this row becomes `VERIFIED`.

### 34: exact empty-Lesson first-page contract

- Root cause: Lesson reads recognized Moodle's native empty first-page route, but the write graph required an existing positive page edit control. Morrow could therefore read an empty Lesson but could not create its first page.
- Repair: an empty graph is valid only on the exact same-origin Lesson page for the bound module with `pageid=0` and `firstpage=1`. The pre-write recheck proves that route and graph remain unchanged. The create request retains `firstpage=1`. Nonempty graphs still require ordinary edit controls and refuse conflicting first-page state.
- Regression: the exact empty route creates one first content page and verifies the resulting one-page graph. Every mismatched route or changed first-page state is refused before POST.
- Focused verification: source syntax passed. Both Moodle course-settings and Lesson test files passed all 5 tests. The focused diff check passed.
- Remaining gate: the complete extension and integrated repository checks must pass before this row becomes `VERIFIED`.

### 37: reviewed Canvas filename identity

- Root cause: the upload asked Canvas to rename a duplicate automatically while authoritative readback required the exact filename the person reviewed. A duplicate therefore caused a provider write that Morrow could never confirm.
- Repair: immediately before upload initialization, Morrow searches the exact bound folder for the reviewed filename. It requires complete bounded result coverage and refuses an exact collision before the upload session or file bytes are sent. Provider-side rename remains enabled only as a race-safe no-overwrite control; any collision after preflight stays unconfirmed because its new filename was never reviewed.
- Regression: an existing exact name and a paged or malformed search both stop after the four read requests with no POST. A no-collision upload verifies its exact bytes and name. A concurrent collision renamed by Canvas remains an unknown effect instead of being falsely confirmed.
- Focused verification: source syntax passed. All 10 Canvas file-transfer tests passed. The focused diff check passed.
- Remaining gate: the complete extension and integrated repository checks must pass before this row becomes `VERIFIED`.

### 80: local-only durable operation status

- Root cause: get, list, and cancel rebuilt historical browser learner scope through current Bridge and provider reads, so one local list could issue one remote read sequence per saved operation.
- Repair: browser-backed and unrecognized operations now expose only their durable privacy-safe control projection. Non-browser records keep their existing strict local projection. The existing opaque keyset cursor remains intact across the MCP egress boundary.
- Regression: active-scope and restart tests prove get, every list page, recent status, and cancel make zero source calls, omit stored learner content, and discover both saved operations through the cursor. All 9 operation integration tests and 3 focused privacy tests passed. The Gateway TypeScript build passed.
- Remaining gate: the complete Gateway and integrated repository checks must pass before this row becomes `VERIFIED`.

### 75 and 76: shipped-byte release evidence

- Repair: public candidate rights and origin records now bind each transformed manifest to its exact shipped digest and reviewed source digest. The final desktop receipt retains a deep copy of the payload source checkpoint.
- Regression: focused release tests prove the derived records match staged bytes, reject source-only evidence during the final scan, and preserve the immutable checkpoint through final receipt construction.
- Focused verification: all 21 release-gate and desktop-provenance tests passed; source syntax and `git diff --check` passed.

### 71: path-derived collection readback identity

- Root cause: the generic planner found the exact immediate parent collection for a PUT, but it discarded the resource ID present in the write path. The evaluator then compared requested fields against the array itself.
- Repair: when the read route is the exact immediate parent of a non-POST write, the planner derives the removed path placeholder, resolves its unique input parameter, and carries that approved argument as the target ID. Updates use `collection-contains-target`; deletes use `collection-omits-target`.
- Regression: an update to discussion entry 77 selects only entry 77 from the normal topic-entry array and verifies its message. A changed message mismatches. Truncated collection coverage stays unconfirmed.
- Focused verification: the Canvas catalog build passed. All 39 catalog tests and all 4 generated connector-package tests passed. The generated browser module matches its TypeScript source, and the focused diff check passed.
- Remaining gate: the complete Canvas connector and integrated repository checks must pass before this row becomes `VERIFIED`.

### 62: observation-preserving Moodle Forum evidence

- Root cause: the read-only target and every discussion readback used Moodle's browser-callable post-list services. Moodle 5.2.2 marks returned posts read when ordinary Forum tracking applies. The same hidden state change also existed in the service used to find a newly created discussion.
- Repair: one strict native Forum CSV export now supplies target evidence, exact discussion structure, new-discussion discovery, and post-write readback. It binds the export to the Forum ID from the exact module form, allows only the native export controls, requires the complete documented 20-column schema, bounds bytes and rows, and keeps author and body fields private. No target or write path calls either unread-mutating post-list service. The public result reports attachment presence, which is the exact fact the export supplies.
- Regression: the complete Forum lifecycle uses the native export before and after writes, confirms the same exact saved outcomes, and asserts that neither `mod_forum_get_discussion_posts` nor `mod_forum_get_discussion_posts_by_userid` is called. The separate Forum export reader remains green.
- Focused verification: source and catalog syntax passed. All 3 Forum lifecycle and export tests passed. The focused diff check passed.
- Remaining gate: the complete extension and integrated repository checks must pass before this row becomes `VERIFIED`.

### 50, 51, and 54: gesture-safe, state-preserving Item Banks setup

- Root cause: course setup launched Item Banks before Chrome's permission request, repeated checks replaced the same account session and deleted its courses and policies, and Item Banks assumed one deployment ID.
- Repair and regression: setup now requests the open tab's observed origins without a hidden launch; a verified same-account check rotates the session while migrating each selected course and valid Edit policy to the new authority; and each Item Banks operation resolves one exact deployment from the selected course's fresh Canvas Tabs record and binds that ID through launch, credential capture, and frame execution. The focused 71-test extension run passed without a live LMS write.
- Remaining gate: the complete extension and integrated repository checks must pass before these rows become `VERIFIED`.

### 89, 90, and 91: durable, ordered update ownership

- Root cause: the Bridge swapped two directories before it persisted recovery state, while the desktop updater committed shutdown before its attempt record and could replace an unresolved attempt.
- Repair and regression: a durable Bridge transaction now binds both receipts, the stage, and rollback before the first rename and converges every cut point on startup. Desktop attempts use exclusive or expected-record writes with exact readback and clear, persist before shutdown commit, release an uncommitted lease on write failure, and block all newer checks until the running update is verified. The focused cut-point, ordering, write-failure, commit-failure, and unresolved-attempt tests passed.
- Remaining gate: native packaged process-exit recovery on macOS and Windows remains required before these rows become `VERIFIED`.

### 92, 93, and 94: ordered desktop and Blackboard state ownership

- Root cause: Electron activation could call window creation while asynchronous desktop initialization still owned the first window. Windows command discovery searched only `PATH`, although the native Claude installer uses `%USERPROFILE%\.local\bin\claude.exe`. Data removal treated the Blackboard route as outside app-owned data, deleted its secret, and left setup unable to read the prior pair.
- Repair: one bootstrap/window barrier now owns initialization, initial window creation, activation, and reopen. It keeps one current-window reference and attaches update delivery only after that window exists. Windows discovery probes the exact native `.exe` path before `PATH` candidates. Blackboard removal now treats its route as removable, confirms the route is absent before deleting secrets, preserves secrets when route removal fails, and accepts a missing prior secret only after fresh account discovery so setup can publish a new matched pair.
- Regression: the real main module receives an activation while Bridge startup is paused and creates one trusted window. Windows detection finds and version-probes only the native executable outside `PATH`. Blackboard tests prove a missing-secret route can be repaired, a failed route removal keeps its secret, a failed secret removal leaves no route, and complete data removal deletes both paths.
- Focused verification: main and shared source syntax passed. The 115-test focused run passed 114 tests with one Windows-only access-control skip and zero failures. The complete desktop installer suite passed 328 of 329 tests with the same expected skip and zero failures. The focused diff check passed.
- Remaining gate: native packaged activation on macOS, native Claude detection on Windows, and the integrated repository checks must pass before these rows become `VERIFIED`.

### 52: course-bound renderer focus

- Root cause: the renderer represented every Blackboard course button by its action name. Several courses can expose the same action, and selecting a course changes that action, so a redraw could move keyboard focus to another course or lose it.
- Repair: a course button now uses its stable course ID as its focus identity. Other controls retain their existing action, assistant, and element identities.
- Regression: two courses expose the same Select action. A window refresh redraws both buttons and restores focus to the exact previously focused course ID. The restored control is enabled.
- Focused verification: the renderer test and focused diff check passed.
- Remaining gate: the complete desktop and integrated repository checks must pass before this row becomes `VERIFIED`.

### 41: allocation-owned multi-file staging cleanup

- Root cause: the planner allocated all Folder file stages inside one `Array.map` expression, then recorded their handles only after the complete expression returned. If a later allocation failed, the earlier successful stage had no cleanup owner.
- Repair: each successful allocation now enters the planner's cleanup set before the next allocation begins. Every later failure discards only those exact handles, removes any operation-to-stage binding created by the failed plan, and cancels the failed operation. Existing stages owned by other operations remain untouched.
- Regression: the store starts with 127 of 128 slots occupied, including one stage bound to another operation. A two-file Folder plan allocates the first file and fails on the second. The regression proves that all 127 prior handles, bytes, and bindings remain exact, while the new handle is absent and its retained buffer is zeroed.
- Focused verification: the Gateway TypeScript build passed. All 10 file-stage, workspace-file, and Moodle file-dispatch tests passed. `git diff --check` passed for the repaired paths.
- Remaining gate: the complete Gateway and integrated repository checks must pass before this row becomes `VERIFIED`.

### 128: native Moodle multiple-select names

- Root cause: both Forum export readers allowed only the logical control names `useridsselected` and `discussionids`. Moodle renders multiple selects with bracketed names, `useridsselected[]` and `discussionids[]`, so the normal native export form was refused.
- Repair: both strict native-form allowlists now accept the exact bracketed names while preserving the existing rejection of unknown controls.
- Regression: both Forum fixtures include Moodle's normal empty bracketed multiple selects. The read-only export and the complete discussion lifecycle both pass.
- Focused verification: both source files passed syntax checks. All 3 Forum lifecycle and export tests passed. The focused diff check passed.
- Remaining gate: the complete extension and integrated repository checks must pass before this row becomes `VERIFIED`.

### 35 and 36: persisted privacy evidence

- Root cause: both privacy boundaries treated incomplete or mutable evidence as durable proof. POSIX mode bits omitted macOS ACL grants, and saved result pages replayed a closure over the 60-second learner roster after the already-redacted bytes had been stored.
- Repair: macOS file and directory admission now fails closed on any extended ACL or inspection failure. Directory hardening sets mode `0700`, removes extended ACLs with `chmod -N`, and verifies both the final mode and ACL. Large results now store only the serialized privacy projection made at admission; paging reads those immutable bytes and retains the existing artifact audience check.
- Regression: a real inheritable `everyone` ACL is rejected, removed by directory hardening, and absent from a newly created credential. Mocked ACL inspection and removal failures also fail closed. A 60,001 ms expired real `LearnerRoster` cannot prevent paging of its already-redacted artifact, and the resolved bytes contain only the learner token.
- Focused verification: the Gateway Core and MCP Server TypeScript builds passed. All 12 private-file-access tests and all 3 result-artifact tests passed. `git diff --check` passed for the changed source and test paths.
- Remaining gate: the complete Gateway and integrated repository checks must pass before these rows become `VERIFIED`.

### 133 and 136: explicit Blackboard recovery and setup-step focus

- Root cause: Blackboard health erased every saved-file failure into the clean absence state, and action redraws had no focus target when the control that started a step disappeared.
- Repair and regression: bounded health states now separate confirmed absence, damaged configuration, missing or mismatched credentials, and refused private access while exposing only safe tenant identity. The desktop offers credential repair or local-only Blackboard removal and suppresses course actions until recovery. A completed user-started action restores its exact control, then the new primary action, then the focusable action heading. The 70 focused Blackboard, contract, and renderer tests passed.
- Remaining gate: the complete desktop suite and native keyboard and screen-reader checks on macOS and Windows must pass before these rows become `VERIFIED`.

### 131, 132, 134, and 135: exact extension discovery and bounded provider delivery

- Root cause: Settings coerced provider IDs through `Number`; Moodle inferred continuation from a full page; twenty provider paths used `Response.text()`, `Response.json()`, or `Response.arrayBuffer()` or an equivalent whole-body allocation before their byte check; and popup refreshes changed two independent labels without an atomic status event. Thirty-three missed calls remained after the first four browser executors were repaired.
- Repair: provider course IDs stay canonical decimal strings; Moodle reads one lookahead row and advances only by emitted timeline rows; all twenty provider readers reject an oversized `Content-Length`, count streamed bytes, cancel at the first byte over the cap, decode text incrementally, parse JSON only from bounded text, and stop stalled body reads at the available deadline or abort signal; Blackboard and browser writes keep an unreadable or oversized post-dispatch answer `applied_or_unknown`; and the popup publishes one combined polite status only when it changes.
- Regression: Canvas preserves `9007199254740993` through selection and exact readback. Moodle totals 99, 100, 101, 199, 200, and 201 end on a nonempty page with every course once. Response regressions cover exact-cap acceptance, declared and streamed overflow cancellation, a stalled deadline, and post-dispatch uncertainty. The repository guard rejects every direct full-body decoder in the provider source trees except seven enumerated packaged-resource and loopback reads. Popup connecting-to-connected refreshes create one combined announcement and repeated identical status creates none.
- Focused verification: the directly affected executor suites, the complete Blackboard package suite, both response-bound guards, affected builds, source syntax, and the focused diff check passed.
- Remaining gate: the complete extension and integrated repository checks must pass before these rows become `VERIFIED`.

### 129, 130, 137, and 138: exact public delivery and provider-bound privacy egress

- Root cause: public-read settlement assumed one browser result shape, nested support reads inherited an outer delivery scope, fixed internal problem codes re-entered privacy projection as ordinary data, and native multi-provider results selected an arbitrary catalog mapping before they established the verified binding provider.
- Repair: delivery now accepts the successful connector envelope for the exact read operation without imposing `sent: true`; private binding and roster reads receive only cancellation; final egress reconstructs approved privacy and capability problems from fixed fields; and native egress selects its privacy mapping from the provider on the exact verified course binding.
- Regression: focused Moodle participant, Forum privacy, assignment privacy, Canvas course-summary, capability-input, historical-operation, and Item Bank tests pass. The eight-case program-scale suite completes forty mixed Canvas and Moodle audits, concurrent groups, privacy-safe retained reports, cancellation, target-conflict settlement, and uncertain-write restart recovery. The Gateway TypeScript build passes.
- Remaining gate: the complete Gateway and integrated repository checks must pass before these rows become `VERIFIED`.

### 141: byte-exact Canvas Inbox body

- Root cause: the private-conversation boundary reused an identifier normalizer for the approved message body. That normalizer returned `trim()`, so it changed leading and trailing whitespace after review.
- Repair: a dedicated payload-text validator now uses trimming only to reject blank-only bodies, enforces the limit against the original UTF-8 bytes, and returns the original body. Identifier fields keep the existing trimming validator.
- Regression: the protocol test preserves leading newline, indentation, trailing spaces, and a final newline, while blank-only and multibyte over-limit bodies fail. The Canvas connector integration test proves the same exact body remains in the frozen plan and in the serialized Bridge command received by the synthetic browser connection.
- Focused verification: the Bridge Protocol and Gateway TypeScript builds passed. All 18 protocol tests, both conversation-plan unit tests, and all 17 Canvas connector integration tests passed. The executable defect reproduction now reports `bytesChanged: false`. The focused diff check passed.
- Remaining gate: the integrated repository checks must pass before this row becomes `VERIFIED`.

### 143: bounded ownership of every accepted Bridge socket

- Root cause: the loopback server retained only its authenticated active socket. An accepted unauthenticated socket kept its authentication timer but had no shutdown owner, so `WebSocketServer.close()` could wait indefinitely for its close handshake.
- Repair: one server-owned set now tracks every accepted WebSocket through closure, and one map owns every authentication timer. Closing first blocks new starts and upgrades, clears authentication timers, stops HTTP admission, sends every peer a graceful close, rejects every pending command, and terminates remaining sockets after a 250 ms default grace period. HTTP and WebSocket closure share the same bounded teardown.
- Regression: one authenticated peer and one unauthenticated peer both pause their transports so neither answers the close frame. With a 100 ms test grace, shutdown force-terminates both, refuses a late connection, rejects the pending Bridge command, clears both socket and timer registries, and returns within one second. The no-client control returns before 500 ms.
- Focused verification: the Bridge Loopback TypeScript build passed. All 23 package tests passed, including 21 server tests. `git diff --check` passed for the changed source and test paths.
- Remaining gate: the complete Bridge and integrated repository checks must pass before this row becomes `VERIFIED`.

### 139: one canonical source identity before startup

- Root cause: configuration preserved source ID case and surrounding whitespace while each stdio client normalized its own ID. The runtime keyed clients by that normalized ID without checking uniqueness. A later source could replace the first map entry after the first process had already published catalog tools, so dispatch and shutdown used a different process from the catalog route.
- Repair: parsed stdio IDs now become canonical at configuration admission, and enabled duplicates fail before configuration returns. Runtime admission repeats the canonical uniqueness check before source verification, journals, brokers, imports, or child startup. Catalog merge independently rejects duplicate canonical source IDs.
- Regression: configuration rejects `Fixture` plus `fixture` and returns a canonical unique ID. Catalog merge rejects an equivalent duplicate pair. A direct typed runtime call with a duplicate pair proves that the child lifecycle log remains empty. A separate later-required-source failure proves that the already-started child records exactly one start and one stop.
- Focused verification: Gateway Core and Gateway TypeScript builds passed. All 25 catalog and reconciliation tests, all 9 configuration tests, and all 11 protocol integration tests passed.
- Remaining gate: the complete Gateway and integrated repository checks must pass before this row becomes `VERIFIED`.

### 142: authority-bound catalog reconciliation

- Root cause: reconciliation computed compatibility from input and output schemas only. Annotation hashes were informational. Equal schemas with different read-only, destructive, or idempotence hints therefore selected one source as compatible. An alias rule for schema drift could also override the authority difference.
- Repair: each tool evidence record now carries a separate digest of the three authority-affecting annotations. Exact-name and alias groups require both schema compatibility and authority compatibility. `allowContractDrift` can select a reviewed schema difference only when all authority annotations remain aligned.
- Regression: exact-name fixtures with read-only, destructive, and idempotence drift each remain `contract_drift`, unselected, and review-required. An alias cannot override read/write drift, while an aligned-authority schema difference still selects the reviewed alias.
- Focused verification: the Gateway Core TypeScript build passed. All 25 catalog and reconciliation tests passed. A synthetic catalog report refused the read/write drift, and its written unresolved row read back as `contract_drift`, unselected, and review-required.
- Remaining gate: the complete integrated repository checks must pass before this row becomes `VERIFIED`.

### 140: authenticated result binding recovery

- Root cause: the provider-effect journal retained only result and readback digests. If the process stopped after Canvas readback was verified but before batch child settlement, recovery could prove the create effect but could not reconstruct the provider-assigned page URL or assignment ID. It marked the source successful while leaving the dependent placement pending and unbound.
- Repair: verified Canvas page and assignment creates now reduce their connector result to one typed binding value. AES-256-GCM binds that value to the exact provider-effect identity, source binding, target identity, upstream result digest, and readback digest. The effect journal stores the encrypted envelope in the same transaction that commits verified readback. Batch recovery authenticates the frozen manifest, source and dependent requests, and artifact, then commits the source success and encrypted dependent request in one SQLite transaction. A missing, mismatched, or unauthenticated artifact puts both source and dependent in explicit inspection-required states.
- Regression: page URL and assignment ID fixtures stop after verified effect readback and before child settlement. Each restart recovers the source and exact dependent field with zero provider dispatches, then one resume and one claim returns the placement. A verified effect without an artifact leaves both children unclaimable and inspection-required. The MCP integration also proves that normal verified page dispatch records the encrypted artifact before batch settlement and stores no raw private page result.
- Focused verification: the Operation Journal, Batch Engine, and Gateway TypeScript builds passed. All 9 Canvas result-binding tests passed. The focused MCP page-binding integration passed. `git diff --check` passed for the repaired paths.
- Remaining gate: the complete Batch Engine, Operation Journal, Gateway, and integrated repository checks must pass before this row becomes `VERIFIED`.

### 144: exact private Canvas identifier contract

- Root cause: the public conversation and file planners declared Canvas course and folder IDs as JSON integers. JavaScript parses JSON integers through `Number`, so a valid Canvas ID above `Number.MAX_SAFE_INTEGER` could change before the exact course binding, review record, and Bridge dispatch were built. The private source schemas also rejected the exact string form already used by the Bridge and Canvas bindings.
- Repair: one decimal-ID contract now accepts canonical strings up to 19 digits and normalizes only positive safe legacy numbers to strings. The reviewed operation, file stage, current binding check, source MCP schema, and Bridge arguments retain the same exact string. Unsafe numeric input fails at admission.
- Regression: conversation and file planning preserve `9007199254740993` exactly, normalize safe numeric 42 to `"42"`, and reject the unsafe numeric form. The Canvas connector publishes exact string schemas for private conversation, course file, and folder identifiers. Integration tests prove a legacy numeric request becomes one canonical string in the saved plan and Bridge command and still reaches verified readback.
- Focused verification: the Canvas Connector and Gateway TypeScript builds passed. All 35 focused Canvas Connector schema tests and all 25 private Canvas planning and dispatch tests passed. `git diff --check` passed.
- Remaining gate: the complete Canvas Connector, Gateway, and integrated repository checks must pass before this row becomes `VERIFIED`.

### 145: reviewed desktop payload release graph

- Root cause: the builder checked only that a few payload files existed, hashed those supplied files itself, and trusted the MCP manifest digest declared by the same prepared directory. A substituted directory could therefore select the bytes that signed-build metadata treated as trusted.
- Repair: one shared packager admission module validates the package-input, MCP-runtime, Bridge-release, dependency-materialization, source-checkpoint, and target-runtime contracts. It inventories every regular payload file into one target-bound SHA-256 graph and rejects links, extra files, missing files, changed bytes, and malformed records. Signed configuration now requires an external admission receipt plus the independently supplied reviewed graph digest. The builder verifies the source payload before returning its configuration and verifies the copied `MorrowPayload` against the same graph in `afterPack`. The package orchestrator passes that graph into the builder, checks the final resource copy, binds it into ASAR metadata, and records it in the installer receipt.
- Regression: signed configuration fails without either external graph input, with a mismatched reviewed digest, and after Node bytes change. A copied payload passes `afterPack` once and fails after the packaged Node bytes change. Invalid Bridge, MCP, package-input, and dependency-materialization contracts fail before builder admission. A real prepared desktop payload produces and verifies one graph, then fails verification after a runtime sibling changes.
- Focused verification: all 17 electron-builder configuration tests, all 7 desktop package provenance tests, and the complete 351-test installer suite passed, with one expected Windows-only skip. Source syntax and the focused diff check passed.
- Remaining gate: the integrated repository checks and native signed builds with platform signature inspection must pass before this row becomes `VERIFIED`.

### 146: one closing desktop lifecycle

- Root cause: bootstrap and quit had separate promise owners. Quit cleaned the globals that existed at that instant and allowed Electron to exit while Bridge initialization was still pending. The continuing bootstrap could then create the updater, IPC handlers, update subscription, and window after cleanup had finished.
- Repair: one lifecycle now owns bootstrap, activation, and quit. Quit marks it closing before any wait, blocks every later open, joins both bootstrap and window creation, cleans the final controller and updater references, and only then issues the allowed final quit. Bootstrap checks the same closing state after each asynchronous boundary, and queued update startup checks it again before starting.
- Regression: the lifecycle test pauses bootstrap after a resource exists, starts quit, attempts activation, and proves bootstrap finishes before cleanup, no window opens, and quit occurs once. The real main-process test pauses Bridge initialization after controller construction, sends `before-quit` and `activate`, and proves exact order `bootstrap-started`, `bootstrap-finished`, `controller-closed`, with zero updater constructions, IPC registrations, or windows.
- Focused verification: main and test syntax passed. All 11 main lifecycle tests passed. The combined lifecycle and desktop-contract run passed all 28 tests. The focused diff check passed. A complete installer run was attempted; its failures are confined to the separately owned update-attempt work and its adversarial update regression.
- Remaining gate: the complete installer run must pass after the separately owned update-attempt work settles, followed by the integrated repository checks and a native packaged quit-during-startup check before this row becomes `VERIFIED`.

### 149: stable focus across passive renderer redraws

- Root cause: background update events replaced the Updates action container and attempted to restore only the removed action. Full passive refreshes recognized buttons but not disclosure summaries, so replacing the action view detached a focused summary with no stable identity.
- Repair: each static or generated disclosure summary now resolves to a stable disclosure identity. Passive update transitions restore an unchanged action and move focus to the local Updates heading when that action disappears. The renderer keeps an unchanged Updates action subtree instead of replacing it.
- Regression: renderer tests redraw two distinct disclosure summaries and require each exact summary to regain focus. An update event removes the focused action and moves focus to the programmatically focusable Updates heading. Real Chromium repeats both behaviors against the shipped HTML and renderer.
- Focused verification: all 26 renderer tests passed. The real Chromium layout and focus suite passed at every supported width. `git diff --check` passed for the owned paths.
- Remaining gate: the complete desktop and integrated repository checks must pass before this row becomes `VERIFIED`.

### 147 and 150: explicit update-attempt state and retriable reconciliation

- Root cause: the attempt store collapsed absence, invalid JSON, unsafe filesystem entries, and read failures to `null`, while the controller marked reconciliation complete before runtime confirmation reached a terminal result.
- Repair: the store now returns explicit absent, valid, or damaged state from one private regular file with a four-KiB read bound. Damage blocks update events, checks, downloads, and installs with `update_attempt_repair_required`. Reconciliation shares one promise, retries unknown or unverified runtime confirmation, and memoizes only a terminal exact clear, rollback, or irrelevant-record removal. `reconcileAfterRepair()` exposes that retry to the main process.
- Regression: malformed, oversized, linked, broadly accessible, and unreadable attempt state is never absence and starts no updater work. Unknown and unverified runtime results retain the exact record, then complete after same-process repair. Concurrent repair calls perform one confirmation and one compare-and-swap clear, and terminal calls perform neither again. All 32 focused update tests, all 20 adversarial installer tests with one expected Windows skip, and all 7 real-updater harness tests passed.
- Main-process integration: a successful repair whose authoritative state reports a ready runtime now calls `reconcileAfterRepair()` before returning the repaired state. The real IPC regression proves the repair and retry occur once and in order. The focused lifecycle, updater, and adversarial suites pass.
- Remaining gate: the complete installer and integrated repository checks must pass before these rows become `VERIFIED`.

### 148: canonical private installer record authority

- Root cause: the controller read `State/installer.json` by path, so the read followed a final or ancestor symbolic link and allocated the complete file before checking any bound. The record validator checked only the outer schema and that `configured` was an object, then preserved arbitrary assistant keys and unchecked identity, path, digest, and extra fields.
- Repair: one shared descriptor-bound reader now admits only a bounded, single-link, owner-private regular file below a real private State directory and confirms the descriptor and path still name the same unchanged file after the read. Record validation reconstructs only the exact current fields, known assistant identities, assistant-specific canonical configuration paths, lowercase SHA-256 digests, and the exact Claude Desktop entry shape. Replacement uses an exclusive private temporary file, flushes that file, renames it, and flushes the State directory. Recovery moves an ordinary malformed record into private Backups without using its fields, removes a linked or nonregular entry at its State path without following it, and writes a fresh record.
- Regression: final-file and ancestor-directory links, directories, oversized files, broad POSIX access, malformed JSON, unknown assistants, foreign or noncanonical configuration paths, malformed digests, and extra fields all fail before record fields are used. Repair leaves a linked target byte-exact, retains an ordinary malformed private file only as an inert private backup, writes one fresh record, and the durability regression observes both the temporary-file and directory flushes. Existing valid ChatGPT and Claude Desktop setup records still round-trip.
- Focused verification: source syntax passed. All 10 state-policy tests, all 52 controller tests, the targeted assistant-management record-recovery test, all 20 Claude Desktop tests, and 20 of 21 adversarial tests passed; the remaining adversarial test is the expected Windows-only access-control check. The complete installer run passed 358 of 359 tests with the same expected skip. The focused and repository-wide diff checks passed.
- Remaining gate: the integrated repository checks must pass before this row becomes `VERIFIED`.

### 155 and 156: byte-preserving JSONC removal with durable recovery

- Root cause: JSON assistant removal parsed settings with strict `JSON.parse`, deleted the Morrow property, and serialized the complete document again. This rejected the comments and trailing commas accepted during setup and changed unrelated formatting and numeric spelling. Removal also changed the assistant file before it committed the installer record. A record-write failure therefore left the assistant file without Morrow while the durable record still claimed the prior digest, so later attempts treated the confirmed removal as foreign drift.
- Repair: Client Config now exports one token-offset JSONC removal operation. It resolves escaped JSON key identity, rejects duplicate semantic containers or Morrow members, removes only the exact member and one adjacent comma, and preserves every other source byte. The installer calls that shared operation. Before an external assistant-file change, it publishes and flushes an exact private tombstone bound to the operation, assistant, canonical target, before and after file digests, and before and after installer-record digests. Record reads report repair while a tombstone exists. Repair accepts only the two bound file states and two bound record states, finishes the missing step once, verifies semantic removal and exact digests, then durably clears the tombstone.
- Regression: JSONC cases cover CRLF, line and block comments, trailing commas, escaped Morrow keys, Morrow in every member position, the VS Code `servers` container, duplicate keys, strings that contain comma and brace text, and integers beyond JavaScript's safe range. Installer tests prove the shared removal route, tombstone file and directory flushes before mutation, restart recovery before mutation, restart recovery after confirmed mutation with zero repeated external writes, repair-required state while pending, and refusal of a tombstone retargeted away from the recorded file.
- Focused verification: the Client Config TypeScript build and all 35 package tests passed. Source syntax and all 77 focused assistant-management and installer-controller tests passed. The complete installer suite passed 363 of 364 tests, with the one expected Windows-only access-control skip.
- Remaining gate: the integrated repository checks and a native Windows durability run must pass before these rows become `VERIFIED`.

### 151, 153, and 154: canonical assistant launch paths and metadata-safe privacy enforcement

- Root cause: client setup verified canonical files but serialized aliases that a later symlink retarget could change; POSIX privacy enforcement swallowed failures and skipped unchanged configurations; and rollback reused an app-owned directory hardener on an existing user-owned parent.
- Repair: every saved repository, workspace, Node, server, and upstream path is the canonical path that setup inspected. Each configured JSON or TOML file is re-hardened even when its logical entry is unchanged. POSIX mode enforcement fails closed, macOS extended ACLs are removed and verified, and rollback restores a present file without changing its existing parent directory.
- Regression: a configuration installed through symlinked inputs retains only their canonical targets after the links are retargeted. An unchanged configuration deliberately widened to mode `0666` is returned to account-only access; the macOS case also injects and proves removal of an inherited `everyone` ACL. Restoring a captured configuration inside a `0775` project leaves the project at `0775`.
- Focused verification: the Client Config build and all 32 package tests passed. All 10 runtime tests passed. The adversarial installer suite passed 20 tests with one expected Windows-only skip. Focused diff checks passed.
- Remaining gate: the complete installer and integrated repository checks must pass before these rows become `VERIFIED`.

### 152 and 158: content-bound Claude Desktop installation proof

- Root cause: the Claude launcher stored canonical runtime paths without their byte identities, and installation inspection accepted a completed MCP handshake from any matching launcher copy. The client-reported name and version supplied the only Claude identity.
- Repair: setup metadata binds bounded byte counts and SHA-256 digests for the sealed runtime manifest, Node executable, server entry, and upstream configuration. The manifest must also bind the exact server entry. The launcher verifies every record before it starts the server and again before it writes the connection receipt. Setup inspection repeats the bounded verification. Installation proof requires the exact Claude-managed extension path. A running launcher also requires a verified Claude process in its ancestry. macOS checks bundle identifier `com.anthropic.claudefordesktop` and team `Q6L2SF6YDW`; Windows checks a valid Anthropic Authenticode signer. Client information remains optional metadata.
- Regression: macOS and Windows path and process-proof dependencies are injected for hermetic tests. Regressions reject a copied launcher, a claimed Claude client name without process proof, each changed runtime input, an oversized upstream file, and a launcher start after runtime mutation. They preserve completed-handshake, Unicode framing, removal, replacement, process-lifetime, and workspace-rebind behavior.
- Focused verification: all 21 Claude Desktop tests and all 21 assistant-management tests passed. The complete installer suite passed 359 tests with one expected Windows-only access-control skip. The live Mac path resolver matched Claude's installed `local.mcpb.morrow.morrow/server/launch.cjs`, and direct signature inspection matched the expected Claude bundle and team identities. The focused diff check passed.
- Remaining gate: the integrated repository checks plus a real Claude-managed handshake on macOS and Windows must pass before these rows become `VERIFIED`.

### 157: one durable Claude Desktop generation authority

- Root cause: each installed Claude launcher trusted only its own retained source and runtime bindings. Repeating setup replaced the installer record without revoking the earlier generated root. Later removal deleted only the newly recorded root, so the older installed copy could keep starting Morrow after the record no longer named Claude Desktop.
- Repair: Claude setup schema v3 embeds the canonical private installer-record path and the exact `{bundlePath, installationId, receiptPath}` entry. The standalone launcher performs a bounded, descriptor-bound record read and requires that exact entry before server spawn, receipt publication, and every running-generation check. Receipt schema v4 and installation inspection enforce the same active entry. Controller replacement, workspace rebind, and removal now run under the existing desktop mutation guard, quarantine every older generated source before the atomic installer-record commit, and clean it only after commit. A private, flushed transition journal binds the before and after record digests and every exact source-to-quarantine move. Restart recovery restores only the exact before state or finishes only the exact after state. Startup replaces legacy v2 setup when possible and otherwise revokes it; orphan generations with no recorded Claude entry are pruned.
- Regression: a real generated A launcher survives unrelated record changes, then exits and clears its proof when the record activates B; A cannot reopen, B cannot start before activation, B can start after activation, and removal stops B while its files remain. Missing, linked, malformed, and oversized records fail before server spawn. Controller tests prove old-root revocation before activation, byte-preserving rollback after record failure, committed revocation despite cleanup failure, both restart-recovery outcomes, legacy migration, orphan cleanup, and concurrent mutation refusal.
- Focused verification: source syntax passed. All 23 Claude Desktop tests, all 30 assistant-management tests, and all 54 installer-controller tests passed. The complete installer suite passed 370 of 371 tests, with the one expected Windows-only access-control skip. Focused diff checks passed.
- Remaining gate: the integrated repository checks plus native Windows transition durability and a real Claude-managed migration handshake must pass before this row becomes `VERIFIED`. No signing, publication, assistant launch, or provider write was used.

### 162: connection-bound saved-result audience

- Root cause: stateless modern MCP requests have neither an MCP session ID nor an authenticated client ID. The result boundary reduced every such local-owner request to the same `stdio-single-client` and `local` audience, even though the owner had already authenticated the exact proxy process and workspace.
- Repair: result-artifact audiences now digest the protocol session and client fields together with the owner-validated proxy PID and workspace digest. Artifact creation and paging derive the same opaque audience from the same connection context. The local owner continues to admit the proxy PID and canonical workspace before it constructs the server.
- Regression: two clients pinned to protocol `2026-07-28` connect through distinct local proxy processes to one durable runtime. The creating client can page its artifact, while the other modern client receives `result_artifact_unavailable` for the same handle. Unit coverage also proves that changing the proxy PID, workspace, or protocol session changes the audience.
- Focused verification: the Gateway TypeScript build passed. All 4 result-artifact tests and all 5 local-owner integration tests passed. `git diff --check` passed for the repaired source and test paths.
- Remaining gate: the complete Gateway and integrated repository checks must pass before this row becomes `VERIFIED`.

### 166: bounded strict-stdio output shutdown

- Root cause: every blocked send installed its own stdout listeners and waited only for a later drain or error. Close detached stdin but owned neither those promises nor the native pipe write, so a peer that stopped reading retained the proxy process.
- Repair: one byte- and count-bounded queue serializes output. Close rejects the active and queued sends, removes their listeners, ends stdout for a 250 ms flush, attempts output destruction, and arms a bounded process-exit backstop only when the real process pipe cannot flush.
- Regression: unit tests prove serial write admission, queue refusal, rejection of every pending promise, listener restoration, and closed-state refusal. A child-process fixture fills a real stdout pipe, proves backpressure, receives EOF on stdin, and exits within the fixed bound while the parent keeps the pipe paused.
- Focused verification: the Gateway TypeScript build, all 6 strict-stdio tests, and the real stdio-entry integration test passed. The strict-stdio suite also passed three consecutive process-exit runs. `git diff --check` passed for the owned source, test, fixture, and ledger paths.
- Remaining gate: the complete Gateway and integrated repository checks must pass before this row becomes `VERIFIED`.

### 164: shutdown-owned single-operation approval work

- Root cause: the approval controller required a shutdown signal for approved batches but exposed the single-operation runner without one. Closing aborted the server controller and then joined every work promise, while `MorrowRuntime` had already called `dispatchOperation` without the signal needed to settle that work.
- Repair: `runApprovedOperation` now requires the same shutdown `AbortSignal` as batch work. The approval server passes its stopping signal to every approved operation, and `MorrowRuntime` forwards it into `GatewayRuntime.dispatchOperation`.
- Regression: a direct approval server starts one approved operation whose only completion path is its signal, then proves `close()` aborts and joins it within one second. A real `MorrowRuntime` approval path pauses before dispatch until shutdown and records `cancelled` with dispatch attempt zero. A second path reaches provider dispatch before shutdown and records `applied_or_unknown` with `provider_effect_may_have_landed`.
- Focused verification: the Gateway TypeScript build passed. All 2 single-operation shutdown tests, the approval maintenance test, and all 9 operation integration tests passed, for 12 focused tests total. `git diff --check` passed for the repaired source, test, and ledger paths.
- Remaining gate: the complete Gateway and integrated repository checks must pass before this row becomes `VERIFIED`.

### 165: generation-owned upstream shutdown

- Root cause: each connection attempt kept its new MCP client and strict stdio transport in local variables until initialization and tool discovery finished. Shutdown could abort only an established client, then waited for the uncancellable initialization request or reconnect timer before the local catch path reached the child.
- Repair: one connection run now owns an abort controller, phase, and exact provisional client and transport before the first initialization await. Close marks the upstream closed once, aborts initialization or backoff, closes the captured provisional transport through its idempotent exit-proved shutdown, and joins only cancellable spawned or timer work. A preparation that has not spawned can no longer retain close; its existing closed check still refuses the later spawn.
- Regression: close before launch preparation settles returns promptly and the released preparation starts no child. A real silent MCP child records its PID, ignores initialization, and is absent by signal-zero readback before both identical close calls settle. A failed reconnect reaches its maximum 60-second backoff; close cancels that wait within one second, rejects the connection, and performs no later launch preparation.
- Focused verification: the upstream TypeScript build and complete 15-test package suite passed. `git diff --check` passed for the owned source, fixture, test, and ledger paths.
- Remaining gate: the integrated repository checks and native Windows child-process shutdown must pass before this row becomes `VERIFIED`.

### 170: bounded private Canvas connector authority state

- Root cause: connector state used ordinary path reads, accepted any readable file metadata, allocated the complete file, and swallowed the final `chmod` result. That state contains the Bridge bearer token and the durable extension allowlist.
- Repair: the state path now resolves through one canonical private directory. Reads require a bounded owner-private regular file, refuse links, use a no-follow descriptor, compare the descriptor with the named inode before and after the bounded read, and reject concurrent changes. Creation and replacement prepare a private file in the same directory, verify it before publication, publish atomically, enforce mode without swallowing failure, and parse exact readback before reporting success.
- Regression: concurrent first load and approval still preserve one token and every allowlist entry. Linked, oversized, and mode-`0644` state files now fail before their contents are used. A configured parent alias is canonicalized once, so retargeting that link cannot redirect a later allowlist write.
- Focused verification: the Canvas Connector TypeScript build passed. Its complete 49-test suite passed, including config, server, privacy, runtime, catalog, and process-shutdown coverage. The focused diff check passed.
- Remaining gate: the integrated repository checks and a Windows ACL run must pass before this row becomes `VERIFIED`.

### 159–161: one revocable extension authority generation

- Root cause: consent, Bridge transport ownership, and Chrome course permission were separate point-in-time checks. Consent withdrawal could race connection setup or an awaited command step. Socket close deleted the active command record, and the cancellation predicate treated that missing record as permission to continue. Disconnect omitted the durable course-connection intent, so a late permission callback could publish a new site anchor.
- Repair: one monotonic course-data authority generation now binds Bridge connection setup, server authentication, hello and binding publication, status, Private Chat roster access, and every command start. Consent withdrawal, Disconnect, and exact active-socket close synchronously invalidate that generation and mark owned commands cancelled. Command records retain their exact socket and Bridge generation until work settles. Pre-effect work stops. A write whose provider call already started retains an explicit `unknown` maintenance receipt. Course permission preparation now also owns a durable generation, and Disconnect atomically removes its intent and writes a tombstone that removes matching late grants.
- Regression: isolated service-worker processes hold catalog loading, a Canvas semantic ownership read, an ordinary Canvas course probe, and an already-started provider write across consent withdrawal or socket closure. They prove zero late socket, read, or write starts, prove the started write remains `unknown`, and prove its stale result cannot cross a replacement socket even when the Bridge reuses the same numeric generation. A final race prepares course access, completes Disconnect, delivers the old Chrome grant and popup completion, and proves no intent, anchor, or permission survives.
- Focused verification: service-worker and test syntax passed. The original 32-test consent, pairing, course-connection, Private Chat, and provider-route set passed. The complete service-worker-referencing group passed all 375 applicable tests. The complete script gate reached 822 passes and failed only two concurrently owned desktop documentation checks: desktop payload admission and stale first-run inventory line citations.
- Remaining gate: the integrated repository checks must pass after the unrelated desktop documentation failures are repaired, followed by the complete Chrome for Testing connector campaign before these rows become `VERIFIED`.

### 168: bounded unauthenticated pairing responses

- Root cause: both pairing routes called `Response.json()` before the fixed loopback server had proved its Bridge identity. Their abort controllers had no deadline and left the controller registry when response headers arrived, before the body was consumed. A stalled body could retain the service worker, and a body without a declared length could allocate without limit.
- Repair: pairing fetch ownership now spans headers and streamed body consumption with one abort controller and a ten-second deadline. The reader rejects a declared body over four KiB, cancels on the first streamed byte over that limit, requires JSON content and fatal UTF-8 decoding, and accepts only the exact pairing-offer, pairing-status, and identity-refusal shapes. Saved pre-fix pairing state must also match the exact fixed-loopback offer before polling its URL.
- Regression: isolated service-worker tests reject a declared 4,097-byte response, cancel an undeclared stream at byte 4,097, settle a body that never finishes through the deadline, and refuse extra fields in both an offer and an approved status. The existing Disconnect race still aborts its exact in-flight pairing response without restoring a token.
- Focused verification: source and test syntax passed. All 13 lifecycle, pairing-authority, and response-decoder guard tests passed. The complete service-worker-referencing group passed all 375 applicable tests, and the decoder guard now permits no direct full-body pairing decoder.
- Remaining gate: the integrated repository checks and the complete Chrome for Testing pairing campaign must pass before this row becomes `VERIFIED`.

### 163: bounded approval and owner HTTP shutdown

- Root cause: both loopback HTTP servers waited on `server.close()` without owning accepted sockets or incomplete request-body readers.
- Repair: one shared lifecycle now sets bounded header and request timeouts, tracks every accepted socket and request, refuses admission after close starts, aborts active handlers, destroys incomplete bodies immediately, and force-closes remaining sockets after a 250 ms grace period.
- Regression: the approval server closes with one complete deferred review and one partial approval body, then refuses a late request. The local owner aborts an authenticated partial maintenance body, removes its descriptor, exits within the fixed bound, and refuses a late connection.
- Focused verification: the Gateway TypeScript build passed. Both new lifecycle test files passed, all 5 existing local-owner integration tests passed, and both approval shutdown suites passed. The focused diff check passed.
- Remaining gate: the integrated repository checks and native Windows socket shutdown must pass before this row becomes `VERIFIED`.

### 167: execution-scoped modern maintenance activity

- Root cause: the owner counted legacy POSTs through response transmission, did not count modern handler execution, and evaluated stale discovery-proxy presence as a second live client.
- Repair: all authenticated MCP POSTs now enter one admission and activity boundary. The count ends when the handler produces its result, before response streaming. Modern initialization can establish durable presence, and maintenance acquisition removes dead session and modern-presence records before it checks the exact live monitor.
- Regression: one pinned `2026-07-28` monitor performs a health request, acquires and releases maintenance while idle, is refused during a delayed tool call, and remains refused when a second live modern client connects.
- Focused verification: the Gateway TypeScript build passed. Both local-owner lifecycle regressions and all 5 existing local-owner integration tests passed. The focused diff check passed.
- Remaining gate: the integrated repository checks must pass before this row becomes `VERIFIED`.

### 191: independently audited dependency trust roots

- Root cause: the repository treated the workspace and standalone installer as one dependency surface. Ordinary workspace audit commands never inspected `installer/pnpm-lock.yaml`, and no automated update policy covered either lockfile. This hid a production MCPB chain on vulnerable `tmp` 0.0.33 and left the workspace on vulnerable Vitest 3.2.7.
- Repair: Vitest now resolves to 4.1.11. The standalone installer overrides MCPB's vulnerable transitive range to compatible `tmp` 0.2.7 because MCPB 2.1.2 is the current release and still declares the old chain. One repository command audits both lockfiles with the correct workspace boundary, the required `check` gate calls it, and Dependabot watches both dependency roots independently.
- Regression: `pnpm audit:dependencies` reports no known vulnerability for either lockfile. `pnpm --dir installer --ignore-workspace why tmp` proves both installer chains resolve to 0.2.7. Gateway Core and Batch Engine both execute successfully under Vitest 4.1.11.
- Remaining gate: the complete repository and installer suites must pass under the new dependency graph before this row becomes `VERIFIED`.

### 192: exact private batch encryption-key authority

- Root cause: batch startup used an ordinary complete-file read and decoded any 32-byte result. It followed final links, accepted multiply linked or broadly readable files, had no byte bound, ignored failed permission repair, and returned a newly generated key before the key file or its directory was durably synchronized.
- Repair: the key parent and final file now have one canonical identity. Existing keys must be bounded, singly linked, owner-controlled private regular files. A no-follow descriptor must match the named inode before and after the bounded read, and the Base64URL representation must be canonical. Creation uses an exclusive private descriptor, flushes the key, proves exact private readback, and flushes the containing directory before returning authority.
- Regression: focused tests prove stable reload, mode `0600`, and refusal of final symbolic links, hard links, oversized content, and mode `0644`. The complete Batch Engine build and all 36 package tests pass under Vitest 4.1.11.
- Remaining gate: the integrated repository checks and native Windows ACL run must pass before this row becomes `VERIFIED`.

### 194: exact private learner-vault authority

- Root cause: the reversible learner mapping used the same path-based key pattern as the batch store. Both the key and encrypted vault were read by pathname, final links were followed, existing access was silently widened or repaired after trust, and complete files were allocated without a strict bound. The envelope decoder also accepted noncanonical Base64URL and extra fields.
- Repair: one shared Gateway Core primitive now owns canonical parent identity, bounded no-follow descriptor reads, single-link and current-owner checks, private-access admission, inode stability, exclusive creation, atomic replacement, exact readback, file flushes, and directory flushes. Both batch and learner keys use it. Learner vault ciphertext has a 64 MiB file bound, decrypted state has a 48 MiB bound and 100,000-record ceiling, and every envelope field has an exact canonical encoding.
- Regression: learner-vault tests prove private key and ciphertext modes and reject a mode-`0644` key, multiply linked key, linked vault, and sparse oversized vault. All 110 Gateway Core tests and all 36 Batch Engine tests pass under the repaired shared primitive.
- Remaining gate: the integrated repository checks and native Windows ACL run must pass before this row becomes `VERIFIED`.

### 195: private legacy Bridge bearer-token replacement

- Root cause: `writeFile(..., { mode: 0o600 })` applies the mode only when it creates a file. Reinstalling over an existing mode-`0644` local module replaced its contents but preserved the unsafe access, and the script never verified its privacy.
- Repair: legacy Bridge installation now uses the shared exact-private-state transaction. It writes a bounded exclusive temporary file, proves private single-link identity, atomically replaces the old path without following it, verifies exact content readback, and flushes the extension directory before reporting success.
- Regression: a temporary pinned donor checkout starts with a broad configuration containing unrelated bytes. A real installer subprocess replaces it with the exact token-bound module, removes the stale bytes, and proves no group or other access remains. The direct install and complete nine-test legacy overlay set pass.
- Remaining gate: the integrated script gate and native Windows ACL run must pass before this row becomes `VERIFIED`.

### 196: descriptor-bound private runtime lease

- Root cause: lease admission used an ordinary complete-file read and converted every read failure into an absent or malformed lease. Heartbeats truncated the lock through its pathname, so a replacement link could redirect the write. Permission repair ran by pathname and ignored every failure. Acquisition closed its exclusive-create descriptor and retained neither the canonical parent identity nor the admitted file identity.
- Repair: the lease now uses the shared exact-private-state boundary for canonical parent selection, bounded admission, and exclusive durable creation. It retains a no-follow read/write descriptor and the exact parent and file identities for its lifetime. Every heartbeat reads and writes at explicit descriptor offsets within a 1 KiB bound, flushes the file, proves exact readback, and rejects a renamed parent or replacement path. State-file hardening opens each exact no-follow file, changes mode through that descriptor, and fails closed unless the same named file has private access afterward.
- Regression: focused tests preserve single-owner and PID-start-time recovery behavior, keep a retargeted ancestor link on the original canonical parent, reject a replaced canonical parent, reject linked, oversized, and broadly readable lease files without changing them, preserve a replacement-link target during heartbeat, and reject a linked state artifact without changing its target.
- Focused verification: the Gateway TypeScript build passed. All 9 state-lease tests and all 11 maintenance tests passed. The focused diff check passed.
- Remaining gate: the integrated repository checks and native Windows identity and DACL runs must pass before this row becomes `VERIFIED`. No provider write was used for this repair.

### 197: lease-loss-owned runtime shutdown

- Root cause: the heartbeat timer caught every ownership failure and continued without transferring the failure to the serving runtime. A second process could then become the state owner while the first process still accepted work against the same authority state.
- Repair: heartbeat failure now deactivates the lease, cancels its timer, closes its pinned descriptor, and reports ownership loss once. Dedicated stdio, local-owner, and approval entrypoints connect the runtime to the lease's canonical state path and bind that report to their existing idempotent close lifecycle. They stop request service, close the runtime, remove owned descriptors, release remaining resources, and exit with failure.
- Regression: a real 500 ms lease timer loses its exact named file and ends the simulated serving lifecycle without changing the replacement. A built local-owner child loses the lock at its production 10-second heartbeat, closes its actual HTTP server and upstream runtime, removes its owner descriptor, preserves the replacement lock byte for byte, and exits with code 1.
- Focused verification: the Gateway TypeScript build passed. The unit lease-loss lifecycle and real owner-process lifecycle regressions passed. The complete state-lease and maintenance group passed 20 tests.
- Remaining gate: the integrated repository checks and native Windows owner-process shutdown must pass before this row becomes `VERIFIED`. No provider write was used for this repair.

### 200: cross-process Canvas connector state transactions

- Root cause: `withStateQueue` exists only in one JavaScript isolate. Separate connector processes could fresh-read the same allowlist, publish competing atomic replacements, and return different in-memory authority from the state that survived. The pre-repair sixteen-process reproduction left one of sixteen approvals in state and caused fifteen approval processes to fail after their readback observed another process's replacement.
- Repair: one transaction now binds the canonical private state path to a bounded private lock record with a random nonce, PID, exact process start time, and acquisition time. Lock publication is exclusive and durable. A contender waits for at most ten seconds and reclaims only a lock whose exact recorded process lifetime is absent, using a same-inode claim before removal. Initial creation and every allowlist update fresh-read and publish their bounded private state through an atomic, flushed replacement with exact readback while holding that transaction.
- Regression: three rounds each start sixteen real Node processes against one absent state file, prove that every process receives one bearer token, release their approval calls together, require every process to succeed, and require all sixteen extension IDs in the final state. Separate tests prove waiting for an exact live owner, recovery after that process exits, recovery from a reused live PID with a different start time, and refusal of linked, oversized, or broadly readable lock files. A state update that would cross the 64 KiB bound fails before replacement and leaves the prior bytes exact.
- Focused verification: the Canvas Connector TypeScript build, all nine configuration tests, and the complete 59-test package suite passed. The process regression completed all three sixteen-process races without a split token, failed approval, or lost allowlist entry. The focused diff check passed.
- Remaining gate: the integrated repository checks and a native Windows process-race and ACL run must pass before this row becomes `VERIFIED`. No provider write was used for this repair.

### 169: operation-bounded provider requests

- Root cause: provider executors checked `expiresAt` before dispatch and bounded many response bodies, but most direct `fetch` calls had no abort signal. A connection or response-header stall therefore retained the in-page operation forever.
- Repair: every direct in-page provider `fetch` now carries an abort signal. The signal uses the exact operation expiry when the serialized executor receives it. Discovery and specialized Canvas executors whose current caller does not expose an operation expiry use a 30-second ceiling. Existing operation-wide controllers remain in place. Write executors still mark dispatch before awaiting the provider, so an abort after dispatch keeps the outcome unknown.
- Regression: a Canvas aggregate read with a fetch that settles only on abort returns in 42 ms at its operation deadline. A Moodle section deletion accepted by the fixture but stalled before response headers returns `sent: true` and `outcomeUnknown: true`, with one dispatch and the provider-side change present. An AST guard covers all 159 direct provider-executor fetch calls outside `service-worker.js` and rejects any call without an approved signal owner.
- Focused verification: source syntax and focused diff checks passed. The complete 113-test Moodle executor suite passed. The 98-test Canvas, response-bound, and deadline group passed, including the static guard and both stalled-transport regressions.
- Remaining gate: the integrated repository checks and the complete Chrome for Testing provider campaign must pass before this row becomes `VERIFIED`.

### 190: exact Canvas result identifiers

- Root cause: the file-transfer executor and Classic Quiz summary accepted canonical decimal string IDs up to 19 digits, then converted course, folder, and quiz IDs through `Number` while building results. Values above `Number.MAX_SAFE_INTEGER` changed before the result crossed the private projection boundary.
- Repair: staged, completed, verified, and aggregate results retain the validated canonical strings used for routing and readback.
- Regression: file-transfer initialization preserves course `9007199254740993` and folder `9007199254740995` as strings. A Classic Quiz aggregate fixture preserves the same class of large course and quiz IDs in its exact result assertion.
- Focused verification: all 12 file-transfer tests and all three Classic Quiz submission-summary tests passed. The wider 98-test Canvas and provider-bound group passed, and the focused diff check passed.
- Remaining gate: the integrated repository checks and a live Canvas tenant with 64-bit IDs must pass before this row becomes `VERIFIED`.

### 210: exact private Moodle enrolment-candidate course identity

- Root cause: the connector admitted canonical decimal course IDs up to 19 digits, then converted the selected course through `Number` in the Bridge command, the page result, and the private result projection. Adjacent IDs above `Number.MAX_SAFE_INTEGER` could therefore collapse to one value. The enrolment executor made the same unchecked conversion for Moodle's integer-only participant-table AJAX filter.
- Repair: the private tool schema accepts canonical decimal strings and accepts numeric compatibility input only through `Number.MAX_SAFE_INTEGER`. The private candidate command, native GET routes, browser result, and connector projection retain the exact canonical decimal string. The participant-table AJAX path proves that the course ID is an exactly representable safe integer before its first request, then sends Moodle the integer its filter contract requires.
- Regression: course `9007199254740993` remains exact through the selected binding, both native Moodle URLs, the Bridge command, the browser result, and the privacy projection. An adjacent-course browser result is rejected. An unsafe numeric input is rejected before Bridge dispatch, and the integer-only participant scan refuses the same large canonical ID before any provider request.
- Focused verification: the Canvas Connector build passed. All 49 Canvas Connector tests passed. All 114 Moodle executor and provider-deadline tests passed, including the exact-ID candidate, pre-dispatch AJAX bound, and unchanged deadline guard.
- Remaining gate: the integrated repository checks and a read-only Moodle tenant with a large canonical course identifier must pass before this row becomes `VERIFIED`. No provider write was used for this repair.

### 171: connection-owned legacy Bridge work

- Root cause: the legacy overlay implemented command and result envelopes but not the canonical cancellation envelope. It had no per-command owner or abort signal. Global socket and generation state also allowed an old asynchronous completion or readiness barrier to act through a replacement connection.
- Repair: one exact connection owner now captures its socket, configuration, authentication state, wire generation, lifecycle controller, and command map. Cancellation matches the exact command and generation, aborts pre-effect work with `request_cancelled_before_dispatch`, preserves `write_outcome_unknown` after the stage dispatch boundary, emits one terminal result, and suppresses late completion. A monotonic install epoch invalidates old readiness barriers.
- Regression: an authenticated fake socket holds a read and a stage request across exact cancellation, proves both signals abort, checks their distinct truth codes, and proves late results cannot cross the connection. A stopped readiness barrier cannot connect after a later install. The legacy MCP runtime test preserves the corresponding `not_sent` and `unknown` result states.
- Focused verification: the Legacy Bridge MCP TypeScript build passed. All 11 package tests and all 11 overlay and privacy tests passed.
- Remaining gate: the integrated repository checks and a scratch-donor loopback exercise must pass before this row becomes `VERIFIED`. No provider write was used for this repair.

### 172: privacy-complete legacy binding identity

- Root cause: the real legacy binding projection advertised a live Canvas course without the principal fingerprint, session generation, and catalog digest required by the public source privacy boundary. An ordinary public course request therefore failed closed before it could return a deidentified roster.
- Repair: a binding is published only from a complete, runtime-verified Canvas session. It now includes a SHA-256 fingerprint of the exact provider principal, the session generation, the authority epoch, and the active catalog digest. An incomplete identity is excluded.
- Regression: the test loads the actual legacy binding module against a donor-session fixture and passes its output into the actual `SourceMcpPrivacyBoundary`. A named learner becomes `Student A1`, while a binding with incomplete session identity is not published.
- Focused verification: all 11 overlay and privacy tests passed, including the real-module privacy-boundary fixture.
- Remaining gate: the integrated repository checks and a scratch-donor read with a current authenticated Canvas profile must pass before this row becomes `VERIFIED`. No provider write was used for this repair.

### 173: content-bound legacy overlay identity

- Root cause: the copied legacy overlay modules asserted only the unchanged donor revision and catalog version. Their own bytes were absent from the authenticated handshake, so a stale or partially refreshed overlay could claim current runtime identity. The installed proof worktree had different bytes for all four copied modules, including the older token-first connection path.
- Repair: one normalized SHA-256 overlay digest covers the ordered filenames and bytes of all four copied modules. Every module embeds that digest, the bridge checks module agreement before it opens a socket, and the MCP requires the composite runtime revision formed from the pinned donor revision and overlay digest.
- Regression: a static guard recomputes the normalized source digest and requires all four modules and the MCP identity module to agree. A WebSocket handshake using only the donor revision is rejected with close code 4403.
- Focused verification: the Legacy Bridge MCP build and all 11 package tests passed. All 11 overlay and privacy tests passed, including the digest guard and stale-revision handshake rejection.
- Remaining gate: the overlay must be reinstalled and inspected in a scratch donor before this row becomes `VERIFIED`. The stale installed proof copy was inspected read-only and was not modified.

### 174: stdio-owned legacy MCP teardown

- Root cause: the legacy entrypoint discarded the synchronous `serveStdio()` handle and installed no stdin-end shutdown owner. Ending the parent input left the loopback listener alive.
- Repair: the entrypoint retains the stdio handle, closes it before the Bridge runtime, and runs the same idempotent shutdown on transport close, stdin end, stdin close, and process signals.
- Regression: a child-process test starts the built entrypoint on an ephemeral port, ends stdin, requires a clean exit within two seconds, and then binds the same port again. The pre-repair executable remained alive after 750 milliseconds and retained the listener.
- Focused verification: the Legacy Bridge MCP TypeScript build passed. All 11 package tests passed, including the process-lifetime and port-reclamation regression.
- Remaining gate: the integrated repository checks and native Windows stdio teardown must pass before this row becomes `VERIFIED`.

### 175: one pinned legacy donor revision

- Root cause: the checked-in federation example kept the placeholder revision `1111111111111111111111111111111111111111`, while the donor manifest, exporter, installer, documentation, and runtime required revision `7275bfbc1c24dd6baff58f9435f1ce5a50fbb5d4`. Following the example therefore failed before launch.
- Repair: the example disposition and `MORROW_LEGACY_EXPECTED_REVISION` now use the exact pinned donor revision.
- Regression: the overlay guard parses the federation example and donor manifest and requires both example fields to equal the exact donor revision.
- Focused verification: all 11 overlay and privacy tests passed, including the pinned-revision contract.
- Remaining gate: the integrated repository checks must pass before this row becomes `VERIFIED`.

### 176: bounded regular legacy source catalog

- Root cause: Legacy MCP configuration called `readFile()` on the environment-selected catalog path before it checked type or size. A linked or oversized file was fully allocated before catalog parsing, and a named pipe could retain startup before the MCP stdio transport existed.
- Repair: startup now opens one no-follow, nonblocking descriptor only after an initial regular-file check. It reads at most 16 MiB in fixed chunks, requires strict UTF-8, and proves the descriptor and named file keep the same identity, size, and modification state through the read.
- Regression: the package loads an ordinary catalog, rejects a final symbolic link, rejects a sparse file at 16 MiB plus one byte, and refuses a named pipe within the fixed test bound without a writer.
- Focused verification: the Legacy Bridge MCP TypeScript build passed. All 11 package tests passed, including the three configuration tests.
- Remaining gate: the integrated repository checks and native Windows path behavior must pass before this row becomes `VERIFIED`.

### 230: identity-bound transactional legacy overlay removal

- Root cause: the remover accepted any directory from `MORROW_LEGACY_ROOT`, read and wrote `extension/background.js` by path, removed any text between broad marker pairs, and force-deleted five fixed filenames without proving donor revision or file identity. It changed the entrypoint before later deletions and had no rollback. A linked entrypoint therefore redirected the write, while unrelated files at overlay names were deleted.
- Executable reproduction: a temporary donor used a `background.js` link to an outside file and placed sentinel content at the five overlay names. The old remover changed the outside file from `keep-before`, marked unknown content, `keep-after` to `keep-before`, `keep-after`, and reported `unknownOverlaySurvived: false`.
- Repair: removal resolves the exact Git root and pinned revision, requires the tracked background, reads every path through a bounded no-follow descriptor, and admits only the exact generated marker blocks, all four current reviewed overlay byte strings, and one exact generated local configuration for that donor revision. It resolves the worktree-aware Git exclude path. Removal moves exact files into a private transaction directory, publishes the unpatched background and cleaned exclude without overwriting an existing path, and restores every byte if a later step fails. Unknown, linked, replaced, multiply linked, or foreign-owned files are refused before deletion.
- Regression: a real temporary Git donor runs the current installer and remover while preserving an unrelated donor file and an edit outside the generated marker blocks. Separate fixtures refuse changed overlay bytes and a linked background without mutation. A fault after all overlay files move proves byte-exact restoration of the entrypoint, Git exclude file, four modules, and bearer-token configuration.
- Focused verification: source syntax passed. The combined install, remove, overlay, and privacy set passed all 18 tests.
- Remaining gate: the integrated repository checks and native Windows file-identity behavior must pass before this row becomes `VERIFIED`. The stale installed proof worktree was inspected read-only and was not removed.

### 231: worktree-aware preflighted legacy overlay installation

- Root cause: installation constructed `${legacyRoot}/.git/info/exclude` directly. A real linked Git worktree stores `.git` as a pointer file, so the final exclude read failed with `ENOTDIR` after the installer had already patched `background.js`, copied four modules, and replaced the bearer-token configuration. Destination and exclude path type, ownership, size, and identity were not admitted before those mutations.
- Repair: installation resolves both the exact worktree root and common Git directory through Git, obtains `info/exclude` through `git rev-parse --git-path`, and requires that result to equal the admitted common repository path. Before mutation it proves the revision, tracked background, clean tracked scope, canonical extension directory, bounded source catalog, every current source and destination file, private-config destination, exclude parent, and bounded no-follow exclude file. It publishes the exclude and modules first, preserves defect 195's exact private configuration replacement, and patches `background.js` only as the final activation step. Every committed path has exact readback, and a later failure rolls earlier changes back in reverse order.
- Regression: one real temporary Git linked worktree has a `.git` pointer file and successfully installs the exact four source modules, private token configuration, background blocks, and repository-common exclude entries. A second linked worktree replaces the common exclude file with a symbolic link and seeds all five destination names with sentinel bytes. Installation refuses that precondition and leaves the background, all destination bytes and modes, and the link target byte-exact.
- Focused verification: installer and test syntax passed. All 3 focused installer tests passed. The combined install, remove, overlay, and privacy set passed all 18 tests.
- Remaining gate: the integrated repository checks and native Windows Git-worktree path behavior must pass before this row becomes `VERIFIED`. No installed proof tree or provider was changed.

### 180–189: frozen release inputs and artifact-bound evidence

- Root cause: the public profile omitted modules loaded by a retained command. Candidate selection and authorization trust could come from mutable local configuration. Package scanning followed a receipt-selected path and compared only the digest declared by that same receipt. External evidence used a working-tree catalog rather than the catalog at the candidate commit. Public source rights did not affect `candidateBuilt`. Desktop workflows used a moving Node release, emitted stable-feed metadata for unsigned QA, uploaded partial failed output under normal names, and produced macOS smoke evidence without owning the retained DMG and complete package artifact set.
- Repair: the public profile includes every startup dependency of its connector packager. Candidate creation requires profile rules equal to the tracked `HEAD` bytes, authorization keys load only from the tracked policy, and evidence binds the catalog at `HEAD`. Package scans reconstruct the exact profile source, transformations, evidence, SBOM, checksums, stage manifest, archive name, archive bytes, and receipt identity. Public build status includes source rights. Both workflows pin Node 22.23.2 and immutable action commits. Unsigned builds have no production publish metadata. Successful artifact upload requires every expected file. The macOS harness validates the package receipt, DMG, ZIP, release graph, source commit, and run ID, then mounts that exact DMG itself.
- Regression: focused fixtures reject a caller-supplied authorization key, an uncommitted profile change, a working-tree catalog substitution, a receipt redirected to unrelated bytes, and a public candidate without rights. Workflow and packager tests require the exact runtime, action commits, success-only uploads, signed-only stable feed, complete macOS artifacts, and a smoke receipt bound to the retained DMG and ZIP. The pre-repair public candidate command failed at startup because `installer/shared/bridge-updates.cjs` was absent; the profile regression now requires its complete local dependency set.
- Focused verification: 65 release, workflow, macOS smoke, CI, and builder tests passed. Six publication-policy and zero-tolerance tests passed. All 7 desktop package-provenance tests passed, including a complete payload build and tamper rejection. Source syntax and the focused diff check passed.
- Remaining gate: run the integrated repository checks and execute the revised macOS smoke on native packaged output before these rows become `VERIFIED`.

### 226: bounded exact public catalog startup

- Root cause: all three public catalog loaders called `readFileSync` before they proved the selected path was a regular file or bounded its size. A FIFO could retain process startup, while a linked, replaced, or oversized sparse file could redirect or allocate before catalog parsing.
- Repair: `@morrow/canvas-api-catalog` now owns one fixed 16 MiB public catalog reader. It refuses a final symbolic link and every non-regular or empty file, opens one nonblocking and no-follow descriptor where the platform supports those flags, reads only the admitted size, requires the descriptor and named path to retain the same device, inode, size, modification time, and change time, and validates strict UTF-8 before JSON parsing. The Canvas API, Canvas browser, and Moodle browser loaders all use the reader. Browser `rawDigest` remains SHA-256 over the exact accepted bytes.
- Regression: an ordinary Canvas API catalog loads unchanged; a final symbolic link is refused; a 16 MiB plus one-byte sparse Canvas browser catalog is refused before allocation; a Moodle browser-catalog FIFO is refused without a writer in under 500 ms; invalid UTF-8 is refused before JSON parsing; and both packaged browser-catalog digests still equal SHA-256 over their raw bytes.
- Focused verification: both package TypeScript builds passed. All 41 Canvas API Catalog package tests and all 57 Canvas Connector package tests passed. The scoped diff check passed.
- Remaining gate: the integrated repository checks and native Windows path behavior must pass before this row becomes `VERIFIED`.

### 215: descriptor-bound release and publication trust inputs

- Root cause: Gateway configuration, public publication policy, packaged runtime identity, release receipts, release profiles, staged candidate files, and retained evidence were read through mutable pathnames. Several JSON parsers allocated the complete file before schema or digest admission, and stat-before-read checks did not bind the bytes to the file identity that had been inspected.
- Repair: runtime and release tooling now use bounded no-follow descriptors. Each read checks the named file against the opened descriptor, pins and rechecks the canonical parent, detects size or metadata changes during the read, and parses only admitted bytes. Gateway configuration is capped at 4 MiB, publication and release JSON at 8 MiB, the packaged runtime manifest at 1 MiB, evidence at 8 MiB, and staged candidate content at the exact rebuilt byte length.
- Regression: Gateway configuration, publication policy, and release-profile tests reject final symbolic links and sparse files one byte above their ceilings. Packaged runtime identity rejects the same substitutions. Candidate scanning rejects a linked staged file even when its target contains the exact expected bytes.
- Focused verification: the Gateway TypeScript build passed. All 16 focused Gateway configuration, packaged-runtime, and public-profile tests passed. All 17 release-gate tests passed. Both release modules passed Node syntax checks.
- Remaining gate: the integrated repository checks and native Windows no-follow/path-identity behavior must pass before this row becomes `VERIFIED`.

### 220: exact private sandbox estate state

- Root cause: the supported persistent sandbox estate used an existence check, an unbounded pathname read, and a coarse cast before trusting arbitrary page text and revision state. Replacement used a temporary file and rename without exact privacy admission, durable directory sync, or authoritative readback.
- Repair: the sandbox now uses the shared exact-private-state boundary. It pins the canonical parent, bounds the file at 16 MiB, requires fatal UTF-8 and the exact deterministic 100-page schema, rejects linked or shared state, and commits the in-memory revision only after atomic durable replacement and exact readback succeed.
- Regression: process-level startup checks reject symbolic links, hard links, mode `0644`, oversized state, and extra schema fields. A real Gateway update proves mode `0600`, single-link identity, no abandoned temporary file, exact saved bytes, and reload through a second sandbox process.
- Focused verification: the Gateway build passed. All 4 sandbox integration tests passed, the 20-test sandbox/config/public-profile group passed, and all 40 Gateway Core privacy tests passed. The scoped diff check passed.
- Remaining gate: the integrated repository checks and native Windows private-access behavior must pass before this row becomes `VERIFIED`. No provider write was used.

### 232: exact private SQLite authority estate

- Root cause: four runtime stores and the recovery CLI opened SQLite paths directly after a recursive `mkdir` whose mode applied only to newly created directories. SQLite therefore created the main database, WAL, and shared-memory files under the ordinary process mask, followed a final link, and admitted hard-linked or broadly accessible authority files. A direct reproduction under the normal `022` mask created all three files as mode `0644`.
- Repair: Gateway Core now owns one SQLite opener. It canonicalizes the private state parent, refuses a shared parent, admits one regular owner-controlled single-link database, securely tightens a legacy mode before opening, rejects existing linked sidecars, pre-creates new databases as mode `0600`, enables WAL, then proves the main descriptor identity and every SQLite journal, WAL, and shared-memory sidecar remains private before returning the connection. Operation Journal, Provider Effect Broker, Durable Batch Store, batch recovery, and batch settlement all use this one boundary.
- Regression: the shared test runs under umask `022`, writes a real WAL database, and proves the main, WAL, and shared-memory files expose no group or other access. It proves a mode-`0644` legacy database is tightened only inside a private directory, refuses a shared directory without changing its file, and rejects a final symbolic link, hard link, and linked WAL before use.
- Focused verification: the Gateway Core build and all 6 private-SQLite tests passed. Operation Journal built and passed all 22 package tests. Batch Engine built and passed all 36 package tests. The workspace lock records Operation Journal's new shared-boundary dependency.
- Remaining gate: the integrated repository checks and native Windows DACL behavior must pass before this row becomes `VERIFIED`.

### 225: one exact Blackboard private-state boundary

- Root cause: Blackboard independently implemented configuration reads, credential reads, session/effect state reads, replacement, and cross-process locking. Metadata was checked by pathname before a second pathname read. Hard links were accepted, response size could change after admission, permission enforcement was best effort, and the duplicate lock schema did not share the exact process and file-identity guarantees used elsewhere in Gateway Core.
- Repair: configuration and credential bytes now pass the shared bounded no-follow descriptor reader after their existing ancestor policy succeeds. Session generations and effect receipts use the same exact private reader, strict UTF-8 decoder, atomic durable replacement, and reusable process-shared transaction as the learner vault. One narrow migration reclaims only a complete legacy Blackboard lock whose exact recorded process has ended, using a hard-link inode claim before deletion.
- Regression: configuration tests reject hard-linked configuration and credential files. The real effect-receipt suite proves fresh-read merge across two state owners, process-shared exclusion, exact reused-PID legacy-lock recovery, and continued refusal when durable state is malformed or broadly accessible. Shared Gateway Core tests cover damaged, linked, shared, stale, and raced transaction ownership.
- Focused verification: Gateway Core and Blackboard builds passed. The 10 configuration tests and 14 effect-receipt tests passed. The complete Blackboard package passed all 249 tests after its legacy encrypted-vault fixture adopted the required private file mode.
- Remaining gate: the integrated repository checks and native Windows private-access behavior must pass before this row becomes `VERIFIED`.

### 205: process-shared learner-vault transactions

- Root cause: each `LearnerVault` loaded the encrypted dictionary once in its constructor. A later token assignment read only that private snapshot and atomically replaced the complete file. Two real workers released at the same barrier both returned `Student A1`; four of five pre-repair races let both calls succeed while the final vault retained only one learner.
- Repair: Gateway Core now owns one reusable exact-private-file transaction primitive. It publishes a complete private single-link owner record, binds the PID to its exact operating-system start time, uses inode-proved hard-link claims for stale takeover and release, bounds lock acquisition, and keeps damaged ownership fail-closed. Learner-vault construction, key creation, fresh read, merge, encrypted replacement, and resolution run through that boundary. Instance state changes only after durable replacement and exact readback succeed.
- Regression: two stale instances preserve both mappings. A cached resolver refuses damaged current state. A reused-PID owner is reclaimed, while malformed and multiply linked owners remain barriers. Twelve two-worker races per run start without a key or vault, synchronize after construction, and require unique labels, both reversible mappings, and no transaction debris.
- Focused verification: the Gateway build passed. The 5-test durability suite passed three consecutive runs, covering 36 real-process races. The complete Gateway suite passed all 121 tests in 12 files. The scoped diff check passed.
- Remaining gate: the integrated repository checks and native Windows lock publication and process-lifetime behavior must pass before this row becomes `VERIFIED`. No provider write was used.

### 235: exact public Moodle integer boundary

- Root cause: all 548 formerly unbounded Moodle identifier positions were published as JSON `integer` values without a maximum. Moodle declares core course, user, section, and module IDs as length-10 integers, maps that width to database `BIGINT`, and requires a 64-bit PHP runtime. Values above JavaScript's exact integer range are therefore valid provider state. The generated schemas admitted them as JSON numbers, while the extension executors accepted decimal identifiers and repeatedly converted them through `Number(...)`. A valid ID could round before a read, ordinary write, learner read, or destructive write selected its target.
- Repair: one generator now owns the exact integer invariant for the generated Moodle catalog. Every non-enum integer input has an explicit maximum no greater than `Number.MAX_SAFE_INTEGER`; the current regeneration added that maximum to all 548 unbounded identifier positions. Catalog admission refuses stale, unbounded, or inexact integer schemas. The public Moodle runtime applies the same schema-directed exact-integer check before any Bridge command. The generated check is part of the repository generated-artifact gate. Defect 210's separate canonical-string private candidate route remains unchanged.
- Regression: the real MCP schema conversion accepts `9007199254740991` and rejects the next unsafe JSON number and a decimal string for `moodle_get_course`, `moodle_update_page`, `moodle_get_assignment_submission`, and `moodle_delete_section`. A direct runtime call with an unsafe numeric or string module ID returns `moodle_integer_out_of_range` with zero Bridge commands. Course discovery rejects a raw provider response whose ID is above the safe boundary before it can expose or select the rounded course. Generator tests cover positive IDs, the zero sentinel Lesson page ID, identifier arrays, bounded controls, enum controls, source immutability, and exact checked-in artifact bytes.
- Focused verification: the Canvas Connector build passed. All 59 Canvas Connector package tests passed. Both generator tests passed. All 116 Moodle browser-executor and provider-deadline tests passed. The generated Moodle identifier check passed.
- Remaining gate: the integrated repository checks and a read-only Moodle site whose identifiers approach the configured boundary must pass before this row becomes `VERIFIED`. No provider write was used.

### 240: exact private local-owner bearer descriptor

- Root cause: the owner descriptor contains the loopback bearer token, PID, port, configuration digest, and journal identity, but both owner and proxy used `lstat` followed by a pathname read with no byte bound or inode binding. Publication used temporary write plus rename with best-effort mode changes, no file or directory flush, and no authoritative readback. The proxy also compared the raw configured `/var/...` journal path with the runtime lease's canonical `/private/var/...` identity, so both lifecycle regressions stopped at modern `Client.connect()` before any maintenance request.
- Repair: descriptor admission now uses the shared 4 KiB exact-private reader and requires one private, owner-controlled, single-link regular file, stable descriptor and pathname identity, exact keys, canonical UUID, bounded token and PID/port values, canonical ISO time, and the canonical journal identity. Descriptor replacement and exact-nonce removal run in the shared process transaction; replacement is private, flushed, atomically published, byte-exactly read back, and directory-synchronized. A prior raw path alias is accepted only when its existing parent resolves to the same canonical journal, then new state is written with the canonical identity. The proxy canonicalizes that identity before discovery.
- Regression: the owner lifecycle proves the descriptor has exactly eight keys, the canonical journal path, byte-exact serialized content, mode `0600`, one link, and a size within 4 KiB. The previously timing-out modern monitor case now completes its idle, active-work, and peer-presence checks. The partial-body case reaches its intended socket shutdown assertions.
- Focused verification: the Gateway build passed. Both lifecycle tests passed in 4.764 seconds and 2.321 seconds. All 5 broader local-owner integration tests passed.
- Remaining gate: the integrated repository checks and native Windows private descriptor and canonical path behavior must pass before this row becomes `VERIFIED`. No provider write was used.

### 241: transactional exact maintenance authority

- Root cause: the desktop maintenance client learned the owner bearer through the same unbounded pathname pattern. Maintenance leases used separate metadata and pathname reads for parsing and fingerprints, accepted extra schema fields, and used best-effort mode changes with hard-link or rename publication. Recovery could check a fingerprint and replace a different later path, and success did not prove durable exact bytes.
- Repair: endpoint and lease admission now share 4 KiB exact-private bounds with no-follow descriptor identity, one-link and owner-private access, exact key sets, canonical identifiers and timestamps, and canonical journal matching. Lease fingerprints cover only admitted exact bytes. Exclusive creation, secret-bound removal, recovery, and stopped-owner replacement use the shared process transaction. Creation and replacement flush private bytes, prove exact readback, and synchronize the directory. Unsafe marker names still block owner startup. Supported path aliases normalize only after their existing parent proves the same canonical journal.
- Regression: focused tests reject symbolic-link and hard-link authority, mode `0644`, files above 4 KiB, and an extra schema key before bearer use or fingerprinting. Creation proves exact serialized bytes, SHA-256 over those bytes, mode `0600`, and one link. Recovery proves the replacement bytes exactly match the returned rotated lease. Existing exact-secret, dead-holder, stopped-runtime, reused-PID, and Bridge-control cases remain green.
- Focused verification: the Gateway build passed. All 13 maintenance tests and both lifecycle tests passed. The complete 5-test local-owner integration file passed. The scoped diff check passed.
- Remaining gate: the integrated repository checks and native Windows DACL and replacement behavior must pass before this row becomes `VERIFIED`. No provider write was used.

### 245: controller-owned desktop download generation

- Root cause: `electron-updater` emits `update-downloaded` from inside its staging callback before `downloadUpdate()` finishes. The adapter forwarded that event immediately, and the controller treated it as readiness authority. A restart request could therefore reach `quitAndInstall()` while later updater staging work was still pending or had failed. The controller also accepted downloaded events outside its active download and let a pending check start an automatic download after `stop()` removed its listeners.
- Repair: the adapter captures one downloaded event only during its active check/download generation and publishes it only after the matching updater promise succeeds. It retains the cancellation token through that operation and revokes it on stop. The controller now makes the successful matching download promise the only transition to `ready`, refuses a downloaded event whose version, platform, or architecture differs from the active candidate, and invalidates every pending continuation when its lifecycle stops.
- Regression: adapter tests prove a valid event remains private until successful staging, a post-event failure publishes nothing, and cancellation discards the captured event. Controller tests prove an early correct event remains `downloading` and cannot install, a different version ends in `update_generation_mismatch`, and a stopped pending check starts no download. The adversarial update fixtures now require controller-owned download completion and prove an unsolicited downloaded event cannot activate any candidate.
- Focused verification: source and test syntax passed. All 105 focused adapter, update, installer-controller, and main-lifecycle tests passed. All 21 adversarial installer tests passed with the expected Windows-only access-control skip. The complete installer suite passed 377 of 378 tests with that same expected skip. The repository diff check passed.
- Remaining gate: the integrated repository checks plus native signed macOS and Windows updates must prove the real platform installer handoff before this row becomes `VERIFIED`. No external network download, signing, assistant launch, or publication was used.

### 250: recoverable exact stale-owner claims

- Root cause: stale-owner recovery used one deterministic hard-link claim, but `EEXIST` always returned false. The normal one-link reader also rejected the canonical owner once that claim raised its link count to two. A reaper exit between claim publication and canonical unlink therefore became a permanent transaction barrier.
- Repair: the shared helper admits a two-link owner only for stale recovery and only when the canonical name and the nonce-derived claim are the same private inode with the same strict bounded owner record. A later reaper can finish that exact interrupted claim. Claim cleanup rechecks the admitted inode before unlinking it. A mismatched name, inode, record, access mode, link count, or live process remains fail-closed.
- Regression: the pre-repair fixture created the exact stale owner and claim pair, then failed at the 100 ms acquisition bound. It now enters the transaction and removes both names. A decoy claim with identical bytes on a different inode still blocks entry and remains unchanged. Existing malformed, arbitrary hard-link, shared-parent, reused-PID, and repeated real-process race coverage remains green.
- Focused verification: the Gateway build and all 7 shared transaction and learner-vault durability tests passed. The complete Gateway suite passed all 123 tests in 12 files. The repository diff check passed.
- Remaining gate: the integrated repository checks and native Windows hard-link recovery must pass before this row becomes `VERIFIED`. No provider write was used.

### 255: exact durable client-configuration publication

- Root cause: client configuration admission split `lstatSync` from an unbounded pathname `readFileSync`, compared only decoded content across the install window, and accepted multiple hard links. Temporary-file privacy restriction also used the name without proving it still referred to the opened descriptor. The final digest repeated an unbounded pathname read, while successful replacement did not flush or exactly reread the published inode.
- Repair: every client configuration read now uses one nonblocking, no-follow descriptor where supported, caps input at 4 MiB, requires one owner-controlled link, validates strict UTF-8, and proves device, inode, byte size, mode, link count, modification time, and change time against the named path before and after the read. Expected state includes that exact identity. Temporary publication proves the restricted name is still the opened inode before writing, flushes the descriptor, atomically renames it, rereads the exact published inode and bytes under private access, and flushes the parent directory. The installed digest parses and hashes only that bounded exact readback.
- Regression: before repair, reinstalling an exact configuration with two hard links returned success and changed the unrelated peer from mode `0644` to `0600`. A deterministic temporary-name substitution also returned success, installed the substitute text, and wrote the intended configuration to the displaced inode. Both cases now refuse; the peer remains byte- and mode-exact, and the displaced inode remains empty because identity is checked before any configuration byte is written. The existing 4 MiB sparse-file refusal remains green.
- Focused verification: the Client Config TypeScript build passed. Both focused identity regressions passed, and the complete package passed all 37 tests. The scoped diff check passed.
- Remaining gate: the integrated repository checks and a native Windows ACL, crash-durability, and replacement-race run must pass before this row becomes `VERIFIED`. No provider write was used.

## Fable 5.1 independent audit findings (2026-09-13)

Recorded from the independent Fable 5.1 audit of branch `codex/defect-root-eradication` at commit `267e7ec09fb9a815f34d353c0d6968e9599b0d39`. The audit verdict was: the branch is not correct and complete. Three P1 and four P2 defects below were unrecorded; eight named P3s follow. Defect 311 was reconfirmed open.

### 313: caller-supplied readback verifies writes on non-Canvas routes

- Verified defect: `packages/mcp-server/src/runtime.ts:634-664,7866-7893` accepts a caller-supplied `_morrow.readback` and marks the write `verified` on every non-Canvas-connector route. The only admission check is `readOnlyHint`. The existing integration test at `operations.integration.test.ts:190-230` shows a write reaching `verified` from an unrelated read the caller chose.
- User effect: any caller can self-certify any write on the MCP, Blackboard, Moodle, and generic routes. Verification no longer proves the platform kept what was planned.
- Required repair: verification must bind the readback to the route's own authoritative read of the written object, not to caller-chosen content. A caller-supplied readback must never satisfy verification on any route.
- Required regression: an adversarial caller submitting an unrelated read as `_morrow.readback` must not reach `verified` on any route; the suite must cover Canvas connector, MCP, Blackboard, and Moodle routes.
- Root cause: `outerOperationControls` accepted a caller-supplied `_morrow.readback` as the frozen comparator for every route that does not embed a connector readback, and verification then compared a digest of whatever read the caller chose, admitting it on `readOnlyHint` alone.
- Repair: a caller-supplied readback is refused on every route before any operation is recorded (`caller_readback_refused`), and the public `_morrow` schema no longer advertises it. Each write route declares its own authoritative review read through `route.planBackend` with the `exact-requested-fields` comparator; Morrow freezes that declaration with the request digest, reads the written object back through that read-only source tool, and reports verified only when the fresh read carries every requested field with the requested value. A saved digest comparator now verifies only when it names the exact Blackboard verify tool Morrow pairs with that apply tool; any other saved readback is unsupported. Corrections derive their readback the same way.
- Regression: an adversarial caller submitting an unrelated read as `_morrow.readback` is refused on the Canvas connector, MCP, sandbox, Blackboard, and Moodle routes with no operation recorded. On the MCP route a write the source kept verifies through the route's own read, and a write whose requested `note` the source's read never returns stays unconfirmed with `readback_did_not_match_frozen_comparator`.
- Meridian route: a Meridian server publishes no capability metadata, and the attested catalog truth is digested without it, so the truth is the authority that declares a Meridian write's review read. The runtime adopts the truth's capability for a live tool that publishes none; the Meridian fixture stays metadata-free and its truth declares `planBackend` for the write.
- Regression contract: the Canvas connector case that expected a caller-supplied readback to be replaced by the connector policy now expects `caller_readback_refused` with no write command sent.
- Status: `IMPLEMENTED`. Ledger row 1 is now closed for every route, not only Canvas connector writes.

### 314: SQLite lock-dropping on live database files

- Verified defect: `packages/gateway-core/src/private-sqlite-state.ts:40-48,89-94` and `packages/mcp-server/src/state-lease.ts:91-133,491` perform raw `openSync`/`closeSync` (and `fchmodSync`) on the live database file, `-wal`, and `-shm` at open time and on every 10-second lease heartbeat, after SQLite has the database open. POSIX advisory locks are released by `close()` of any descriptor for the inode, so each call silently drops the SHARED lock SQLite holds on the WAL-mode database and the DMS lock on `-shm` while SQLite still believes it holds them.
- User effect: any other process that opens the same journal file (sqlite3 CLI, a maintenance script, or a second gateway whose lease check returned null) can obtain EXCLUSIVE on the DMS byte, reinitialise `-shm`, and on close checkpoint and delete `-wal` while the gateway keeps appending commits to the unlinked WAL inode. Effect records and approvals are lost or the file is corrupted. This is the documented SQLite "How To Corrupt" section 2.2 path, applied to the effect and batch authority stores.
- Required repair: the file-hardening goal must be achieved without opening live database files. Apply permission hardening before SQLite opens the path, or harden a private copy and atomically install it, or prove descriptor-level safety; never `open`/`close`/`fchmod` the live `-wal`/`-shm` under a running connection.
- Required regression: a test that opens the store, runs the hardening/heartbeat path, and then proves from a second connection that the journal lock discipline still holds (no EXCLUSIVE obtainable, WAL intact across interleaved commits).
- Root cause: admission and the lease heartbeat proved database identity by opening a descriptor on the live database, `-wal`, and `-shm` and closing it, and hardened access with `fchmod` on that descriptor. POSIX advisory locks belong to the process, so each close silently dropped the SHARED and shared-memory locks SQLite still believed it held.
- Repair: identity is proven from path metadata only, before SQLite opens the path, and hardening uses a path permission change followed by a metadata reread that must name the same inode. No live database or sidecar is ever opened outside SQLite.
- Regression: a second operating-system process asks to leave WAL mode, which SQLite grants only when no other connection holds its locks. After reopening a populated journal, and after each heartbeat hardening pass, that request is refused as locked and interleaved commits remain intact; after close it succeeds. Before repair the second process was granted `delete` while the gateway connection was open.
- Status: `IMPLEMENTED`.

### 315: darwin-forced tests fail on Linux, CI merge gate cannot go green

- Verified defect: `packages/gateway-core/src/private-file-access.ts:177-179,207-209` shells to `/bin/ls -lde` on the darwin branch. Four tests force `platform: "darwin"` without stubbing the shell-out (`private-file-access.test.ts:22-45`, `local-owner-maintenance.test.ts:56-62`) and fail on Linux. The required `check` job from defect 274 runs on `ubuntu-latest`.
- User effect: the merge gate the defect pass itself created cannot pass for this commit. Reproduced on the audit host: gateway-core 3 failed / 120 passed, mcp-server 1 failed / 41 passed.
- Required repair: make the platform-specific tests hermetic. Stub the `ls -lde` invocation (or the platform layer) so the darwin branch is tested without a macOS host, and prove the full `check` suite passes on Linux.
- Required regression: the four tests must pass on Linux; a CI-equivalent Linux run of the required `check` job must be green.
- Root cause: the darwin branch decided extended-ACL state inside `spawnSync("/bin/ls", ["-lde", ...])`, so a test forcing `platform: "darwin"` on Linux ran the real shell-out and failed.
- Repair: the listing decision is the pure function `classifyMacAclListing`, and the platform layer accepts injected `classifyMacAcl` and `removeMacAcl` decisions, so the darwin branch runs without a macOS host.
- Regression: real macOS listings with and without a `+` mode flag or numbered ACL entries classify as expected, an injected extended ACL refuses the sidecar, and the four formerly failing tests pass on Linux.
- Status: `IMPLEMENTED`.

### 316: crash-window transaction lock wedge

- Verified defect: `packages/gateway-core/src/private-state-file.ts:437-459` publishes a hard-link `${lock}.release-<nonce>` claim, then `unlinkSync(lock.path)`. If the process dies between `linkSync` (`:440`) and the unlink (`:455`), the lock file is left with `nlink === 2` and a `.release-*` sibling. Every later `acquireTransaction` then fails permanently: `publishTransactionOwner` returns false (EEXIST); `readTransactionOwner` throws because the reader requires `nlink === 1`; the fallback `readInterruptedReclaimOwner` only recognises `.reclaim-<nonce>` claims and returns null for `.release-*`; the loop spins until deadline and throws `admissionFailure`. Nothing ever unlinks the stale lock.
- User effect: `LearnerVault` construction, every `prepareTextReferenceSets`/`resolve`, owner-descriptor writes, Blackboard durable state, and maintenance-lease writes all run inside this transaction. A single crash in that window makes the gateway unable to start until a person hand-deletes `<file>.transaction.lock` and `<file>.transaction.lock.release-*`.
- Required repair: make the release path crash-atomic or teach the reclaim path to recognise and finish an interrupted release claim for the same private inode, the way stale-owner recovery already handles interrupted claims.
- Required regression: a fixture that kills the process between claim publication and unlink must be recoverable by the next acquirer with no manual deletion; a decoy release claim on a different inode must still refuse.
- Root cause: release linked `<lock>.release-<nonce>` and then unlinked the lock; a crash between the two left a two-link owner that no later acquirer recognised, because reclaim only understood `.reclaim-<nonce>` claims.
- Repair: admission recognises an interrupted claim of either kind for the same private inode. A release claim whose owner process no longer runs is finished by the next acquirer, exactly as an interrupted reclaim is; a live owner still finishes its own release. Admission also has an asynchronous form that yields between attempts instead of blocking the event loop.
- Regression: a worker enters the transaction, publishes its release claim, and is killed before the unlink; the next acquirer enters within 200 ms and leaves the directory empty. A release name that is not the stale owner's exact inode still refuses and leaves both names untouched.
- Status: `IMPLEMENTED`.

### 317: privacy redaction bypass on status/grade-type keys

- Verified defect: `packages/gateway-core/src/privacy.ts:882-884,1197`. In `redactLearnerEgressPrepared`, a string whose key matches `nonIdentityScalar` (`.*status`, `.*page`, `.*rows`, `.*index`, `.*attempt`, `.*size`, `.*limit`, `depth`, and similar) is returned as-is with no learner redaction and, unlike the sibling branch in `projectValue` (`:1113-1116`), no `containsSensitiveText` check. New in this pass from the projection rewrite.
- User effect: `{ "grading_status": "Submitted by jane.doe@school.edu" }` or `{ "rows": ["Jane Doe, 95"] }` reaches the assistant unchanged through the egress path, while the same content in a field named `note` is refused. Learner-identifying data leaks to the model.
- Required repair: the egress redactor must apply the same sensitive-text refusal to `nonIdentityScalar` keys as `projectValue` does, or prove key-shape can never carry identity content.
- Required regression: adversarial payloads under `grading_status`, `rows`, `score`, and similar keys carrying emails and names must be redacted or refused; the existing `note`-key behaviour must stay green.
- Root cause: `redactLearnerEgressPrepared` returned any string under a `nonIdentityScalar` key unchanged, without roster redaction or the sensitive-text refusal that the sibling projection branch applied.
- Repair: text under a measure- or status-shaped key is still provider-controlled text. Both paths now run roster redaction on it, with only the bare-numeric-id-is-a-person rule disabled for that key shape, and refuse sensitive text; structural reference fields refuse sensitive text too.
- Regression: `grading_status`, `rows`, and `score` values carrying a roster name are tokenized on the egress path and in projected output; the same keys carrying an unknown email or a bearer token are refused; a bare number under `score` stays a number while the same digits under `note` stay a person.
- Status: `IMPLEMENTED`.

### 318: per-request synchronous process spawn blocks the owner event loop

- Verified defect: `packages/gateway-core/src/process-lifetime.ts:19-47` and `packages/mcp-server/src/local-owner.ts:698`. Liveness checks moved from `process.kill(pid, 0)` to `processMatchesRecordedLifetime`, which calls synchronous `spawnSync("/bin/ps", ...)` (POSIX) or `spawnSync("powershell.exe", ...)` with a 3 s timeout (Windows). `recordModernProxy` runs it on every modern-protocol MCP request, the session reaper runs it once per client every 1 s, and `waitForOwner` runs it every 25 ms while the owner starts.
- User effect: each call blocks the single owner event loop for a process spawn (tens of ms on POSIX; PowerShell start is typically 0.3-1.5 s on Windows), so every tool call through the local owner on Windows adds a synchronous PowerShell launch and stalls all other proxy sessions for that time.
- Required repair: make liveness checks asynchronous and cached: resolve process start time once per owner lifecycle (or on a bounded background interval) and compare without spawning per request. Never `spawnSync` on a request path.
- Required regression: a concurrency fixture proving N parallel modern-protocol requests do not serialise on process spawns; a source guard forbidding `spawnSync` on the request path.
- Root cause: every request-path liveness check called `processMatchesRecordedLifetime`, which ran a synchronous `ps` or PowerShell child per call.
- Repair: request paths use `requestPathProcessMatches`, a process-wide matcher that answers Linux from procfs with no child process and answers other platforms from a start time cached for five seconds and refreshed by one background asynchronous query; `process.kill(pid, 0)` still runs on every call so a dead process is never reported alive. The session reaper, modern-proxy admission, maintenance recovery, and monitor checks all use it.
- Regression: 32 concurrent request-path checks answer immediately from one background query while the fake `ps` is still held open, and Linux checks answer from a procfs fixture with an absent `ps`.
- Status: `IMPLEMENTED`.

### 319: gateway cannot start where process-start introspection is unavailable

- Verified defect: `packages/gateway-core/src/private-state-file.ts:292-299,380` and `process-lifetime.ts:38-46`. `acquireTransaction` requires `exactCurrentProcessStart`, which returns null (and therefore throws "transaction process lifetime is unavailable") whenever `/bin/ps -o lstart= -p <pid>` is missing, exits non-zero, or prints a format `Date.parse` cannot read.
- User effect: in minimal containers or non-C locales that localise month names, every `withExactPrivateStateFileTransaction` caller fails, including `LearnerVault` construction, so the gateway cannot start at all.
- Required repair: provide a fallback process-identity mechanism that does not depend on `ps` output parsing, or degrade the lifetime check with a documented bound instead of refusing startup.
- Required regression: a fixture with `ps` absent (and one with localised month names) must still construct the vault and acquire transactions.
- Root cause: the only start-time source was `ps -o lstart=` parsed by `Date.parse`, so a missing `ps` or a localised month name made transaction admission throw and the vault unconstructible.
- Repair: Linux reads `/proc/<pid>/stat` against `btime` and never starts a process; other platforms run the query under `LC_ALL=C`, retry a failed spawn, and answer null instead of throwing. Exact-start comparison is by whole second because `ps` records whole seconds.
- Regression: with every child-process entry point mocked absent, the learner vault constructs and transactions acquire on Linux; a German `ps` output parses through the C locale; an absent query answers null.
- Status: `IMPLEMENTED`.

### 320: unbounded MCP awaits in client-config CLI

- Verified defect: `packages/client-config/src/cli.ts:466-470` awaits MCP operations with no deadline, caller signal, or settlement race.
- User effect: a stalled peer can freeze the client-config CLI indefinitely on its primary path.
- Required repair: give every CLI MCP operation an owned deadline and cancellation path consistent with the operation-boundary pattern used elsewhere in this pass.
- Required regression: a stalled-peer fixture proving each CLI operation settles within its bound.
- Root cause: `callMorrowTool` awaited `client.connect` and `client.callTool` with no deadline or settlement race.
- Repair: each exchange runs under an owned deadline taken from `--startup-timeout` and `--tool-timeout` (the tool call defaults to 60 seconds), passes its signal and timeout to the SDK, races settlement itself, then closes the client and transport within a bound and reclaims the child process with SIGTERM then SIGKILL.
- Regression: a raw stdio peer that stalls before or after `initialize` and ignores SIGTERM makes `backend status` exit 1 within the bound with the named operation, and the peer process is gone afterwards.
- Status: `IMPLEMENTED`.

### 321: duplicate contradictory ledger entries for defect 274

- Verified defect: two closure entries exist for defect 274 with contradictory status: `### 274: enforced GitHub merge protection` (`VERIFIED`) and `### 274: unbound repository merge gate` (`OPEN`, "This checkout does not alter GitHub provider configuration"). The stale OPEN entry was never removed; it is the only duplicated `### <id>:` heading in the ledger (192 headings, 1 duplicate).
- Required repair: remove the stale entry and keep the single authoritative 274 row. Add a ledger lint that fails on duplicate `### <id>:` headings.
- Repair: the stale `### 274: unbound repository merge gate` entry is removed; the single `VERIFIED` closure remains. `scripts/test/defect-ledger.test.mjs` fails on a duplicated closure heading or table row, on a closure heading without a table row, and on an unknown status.
- Regression: the lint failed on the ledger as committed (duplicate heading 274, fourteen closure headings without rows) and passes after this repair.
- Status: `IMPLEMENTED`.

### 322: fifty ledger IDs missing with no explanation

- Verified defect: 50 defect IDs in the ledger's numbering have no row and no recorded reason (skipped, merged, or reserved).
- Required repair: account for every missing ID in a ledger appendix (merged into X, reserved, or never assigned) so the numbering is auditable end to end.
- Repair: the `Identifier accounting` appendix records every identifier without a row and its disposition, and the ledger lint requires every identifier up to the highest row to be exactly one of a row or an accounted gap.
- Regression: the lint failed on the ledger as committed and passes after this repair.
- Status: `IMPLEMENTED`.

### 323: wrong first-run inventory citation the guard cannot detect

- Verified defect: `FIRST-RUN-STATE-INVENTORY.md:563` cites a wrong source line, and the inventory guard cannot detect it because it matches identifier substrings rather than exact rendered source lines.
- Required repair: correct the citation and strengthen the guard to resolve every cited control against the exact rendered source line, failing on substring-only matches.
- Required regression: a fixture with a substring-matching but line-wrong citation must fail the guard.
- Root cause: the control guard accepted any line whose text contained the control name, so `Remove` matched a comment at `installer/renderer/renderer.js:327` and `Cancel` matched the identifier `Cancelled` at `packages/mcp-server/src/approval-server.ts:778`.
- Repair: `renderedOnLine` accepts a citation only when the name stands as a whole word inside a string or template literal, HTML text, or an attribute value; comments, identifiers, and longer words never qualify. The two citations now name lines 398 and 963, where the controls are rendered.
- Regression: the former citations contain the names as substrings and fail the strengthened guard, and fixtures for identifier, longer-word, comment, and attribute cases pass or fail as required.
- Status: `IMPLEMENTED`.

### 324: three source-guard tests defeatable by trivial rewrites

- Verified defect: three source-guard tests in this pass can be defeated by trivial rewrites that preserve the forbidden behaviour under a different shape.
- Required repair: rewrite the guards to test behaviour (via adversarial fixtures that exercise the forbidden path) rather than source shape, so a rename or restructure cannot silently reintroduuse the defect.
- Required regression: the trivial-rewrite variants must fail the strengthened guards.
- Root cause: the three guards matched text windows: one regular expression per line for an awaited `.cancel(`, a nine-line window after `content-length`, and a five-line window after `if (!response` that also had to contain `getReader`.
- Repair: `scripts/test/lib/provider-response-analysis.mjs` decides both invariants on the syntax tree with data flow: a cancellation promise may not be awaited wherever it flows (variable, renamed helper, promise combinator, chained catch, or an async helper that settles with it), and every exit that abandons a fetched or received response before its body reaches a reader, a whole-body decoder, or another function must cancel on that same path, with only a proven body absence exempt. The guards run over every provider file.
- Regression: eight forbidden fixtures fail the analyser; the former text guards accepted six of them. Applied to the provider sources as committed, the analyser found the thirty abandonment paths recorded as defect 328.
- Status: `IMPLEMENTED`.

### 325: defect 264 regression is a wall-clock bound only

- Verified defect: the regression test recorded for defect 264 asserts a wall-clock bound rather than the underlying invariant, so it can pass while the defect recurs and can flake under load.
- Required repair: replace the timing assertion with a deterministic invariant the defect would violate (ordering, single-settlement, or state proof).
- Root cause: the defect 264 regressions asserted elapsed time under 3 and 5 seconds.
- Repair: both tests count durable vault transactions through a mocked transaction primitive and require exactly one for 2,000 protected references and for 2,500 learner records, with the second test moved from an in-memory vault to a file-backed vault so the count is real.
- Regression: the 2,500-record count failed against the code as committed with 2,501 transactions (defect 327) and passes with one after that repair.
- Status: `IMPLEMENTED`.

### 326: second lock implementation contradicts the "one primitive" claim

- Verified defect: `packages/canvas-connector-mcp/src/config.ts` carries a second state-transaction lock implementation whose release path differs from the shared primitive, contradicting the ledger's "one primitive" claim for the lock work.
- Required repair: either migrate the connector to the shared primitive or record the second implementation as an explicit, tested exception with its own crash-window analysis.
- Root cause: the connector kept its own lock schema, claim, reclaim, and release code beside the shared primitive.
- Repair: the connector serialises state changes through `withExactPrivateStateFileTransactionAsync`, the shared primitive's non-blocking form, keeping only an in-process queue and a one-way reclaim of a dead owner's lock in the superseded connector schema so an upgrade under such a lock can enter.
- Regression: a live legacy lock refuses admission and stays intact, a dead owner's legacy lock is removed and admission proceeds, and linked, broadly readable, and oversized lock names are refused through the shared primitive's own admission.
- Status: `IMPLEMENTED`.

### 327: per-record durable vault transactions in projection and egress

- Verified defect: found while replacing the defect 264 wall-clock regression (row 325) with a transaction count: 2,500 learner records through a file-backed vault made 2,501 durable transactions.
- User effect: a large roster response reopens, decrypts, and closes the encrypted vault once per learner record, which is the same starvation defect 264 closed for text references.
- Root cause: `redactLearnerEgressPrepared`, `projectValue`, `redactLearnerNumber`, and `redactLearnerKey` tokenized each learner record through `learnerVault.tokenize`, and `learnerIdentity` resolved each existing token through `learnerVault.resolve`; with a file-backed vault each call is one durable transaction, although the prepared snapshot already publishes every roster label.
- Repair: the prepared context carries the snapshot's label for every roster identity and a label-to-identity index; records and tokens resolve through it, and the vault is asked only for an identity outside the snapshot.
- Regression: 2,500 learner records through a file-backed vault made 2,501 transactions before repair and one after; the privacy suite ran in 1.4 seconds instead of 166.
- Status: `IMPLEMENTED`.

### 328: provider refusal paths that abandon a live body

- Verified defect: found by the syntax-tree guard that replaced the text-window guards (row 324): thirty refusal branches in 17 Bridge source files return or throw with a fetched body still live.
- User effect: a refused or redirected provider response keeps its network stream alive after Morrow has produced its terminal result, the defect 308 and 309 closures claimed to have removed.
- Root cause: thirty refusal branches returned or threw after `fetch` produced a response and before a reading helper received it, without cancelling the body: `!response.ok` and route checks in Canvas content, file, hot-spot, and Moodle executors, redirect and context checks in the BigBlueButton, LTI, and enrolment executors, invalid `Location` and `response.url` handling, and a content-type refusal in the pairing reader.
- Repair: each branch now starts the same best-effort body cancellation used elsewhere before it returns or throws.
- Regression: the analyser reports zero abandonment paths after repair and thirty on the sources as committed.
- Status: `IMPLEMENTED`.

### 329: exact private file reader refuses its own fresh readback on multigrain-timestamp kernels

- Verified defect: found while closing row 313 on a Linux 7.0 host whose home directory is an overlayfs mount. `readExactPrivateStateFileWithLinks` compared `ctimeMs` between the descriptor stat taken after open and the one taken after the read. On that host the kernel refined the ctime of a freshly written inode by under one millisecond after it was first queried, with no content, size, mode, owner, link, or identity change: 31 of 2,000 `replaceExactPrivateStateFile` calls under the home directory were refused with `changed while it was read`, and none under tmpfs.
- User effect: every durable record that is written and then read back through this reader fails intermittently in that environment: Blackboard session bindings, effect receipts, and learner vault transaction owners. The Blackboard plan, dispatch, and read paths then refuse with `blackboard_session_unavailable`, `blackboard_effect_record_unavailable`, or `blackboard_response_incomplete`, and the Blackboard integration suites failed 10 of 23 cases.
- Root cause: ctime is not a content attribute. The admission decision depends on identity, link count, size, mtime, mode, and owner; the reader re-checked all of those and also ctime, which the kernel may refine without any change the reader can act on.
- Repair: the after-read comparison re-checks exactly the attributes admission decided on (device and inode, link count, size, mtime, mode, and owner) on the open descriptor and by name, and no longer compares ctime.
- Regression: with a stat layer whose ctime drifts on every query, a freshly created file reads back and reads again; with a drifting mtime the same read still refuses with `changed while it was read`. The first case failed on the reader as committed.
- Remaining limit: six sibling readers keep a ctime comparison (`packages/legacy-bridge-mcp/src/config.ts`, `packages/mcp-server/src/moodle-resource-file.ts`, `packages/mcp-server/src/state-lease.ts`, `packages/canvas-connector-mcp/src/config.ts`, `installer/shared/claude-desktop.cjs`, `installer/shared/state-policy.cjs`). None failed on the affected host; they read files a person or installer wrote earlier rather than this process's own fresh write.
- Status: `IMPLEMENTED`.

### 311 (reconfirmation, 2026-09-13)

- The Fable 5.1 audit reconfirmed defect 311 remains open: `installer/shared/runtime-monitor.mjs:540-651` still awaits MCP operations with no caller signal, owned deadline, or outer settlement race. The SDK caps each await at 60 seconds, so "indefinitely" is overstated, but waits compound to minutes and cannot be cancelled. Repaired in the same delivery as rows 313-328; see the primary 311 entry.
