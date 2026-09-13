# Morrow defect-eradication handoff

Date: 2026-09-13

Delivery branch: `codex/defect-root-eradication`

Baseline commit: `d262ac47571dbba8a617f47b80ec7223c4ab46bd`

The complete repair set and this handoff are committed together on the delivery branch. The authoritative finding record is [DEFECT-ERADICATION-LEDGER.md](./DEFECT-ERADICATION-LEDGER.md). Read that ledger before changing a repaired boundary. It contains each verified failure, its root family, the repair, the regression, and any proof that still needs a native or live target.

## Delivery state

This pass records 262 validated defect rows. They contain 78 P1, 170 P2, and 14 P3 findings. The current statuses are:

- 259 `IMPLEMENTED`: source and focused regression are complete.
- 2 `VERIFIED`: defect 274 is confirmed against GitHub's live branch-protection resource, and defect 312 passed the complete integrated repository gate.
- 1 `OPEN`: defect 311 is the unbounded Desktop runtime-monitor MCP boundary described below.

The repository diff changes the Gateway, MCP server, Desktop app and installer, Chrome Bridge, Canvas and Moodle browser executors, Blackboard REST runtime, release tooling, generated contracts, CI, privacy projection, operation journal, batch engine, updater, documentation, and tests. The source-origin ledger and source-rights manifest were regenerated for this tree.

No live LMS write, signed public package, notarization, release publication, or production user migration was performed during this delivery.

## Root-cause map

The audit found nine repeating failure families. Future work should repair the shared boundary when a new case belongs to one of these families.

| Family | Repeated failure | Durable control now used |
| --- | --- | --- |
| R1 exact effect identity | A write could be confirmed by similar, stale, or unrelated evidence. | Frozen source, account, course, target, request, pre-state, provider identity, and exact readback travel together. |
| R2 durable authority transaction | Approval, batch, rollback, cancellation, staging, and recovery could settle in different stores. | One terminal state transition owns admission, effect authority, compensation, and recovery. |
| R3 typed privacy projection | Generic value matching treated ordinary IDs or scores as learner identity. | Provider-specific result types and exact-course identity contexts drive projection. |
| R4 provider contract fidelity | Local schemas changed official identifiers, omitted valid fields, or assumed the wrong response shape. | Shared provider contracts preserve official values and validate only explicit invariants. |
| R5 protocol and session lifecycle | Framing, cancellation, replay, generation, and process shutdown diverged across layers. | Shared strict codecs, generation-bound sessions, cancellation ownership, and bounded process reclamation control the lifecycle. |
| R6 Desktop state ownership | Setup, repair, update, rollback, removal, and client configuration trusted mutable path state. | Exact private files, canonical identity, durable state machines, compare-and-swap receipts, and removal tombstones own Desktop state. |
| R7 release evidence graph | Release checks accepted cached, pre-transform, unrelated, or unresolved evidence. | Content-addressed evidence binds source, generated files, package bytes, dependency graph, authorization, native proof, and current readback. |
| R8 bounded execution | Network, stream, process, scheduler, redaction, and recovery paths could wait or grow without a hard limit. | Exact byte bounds, fatal decoding, deadlines, nonblocking cancellation, process-tree ownership, and fixed concurrency budgets close every terminal path. |
| R9 accessible interaction identity | Repeated controls or changing views lost their exact visible target, focus, or announcement. | Visible target names, stable focus identity, live-state ordering, and rendered multi-width checks bind the interaction. |

The strongest general lesson is that validation must use the same object, bytes, process, course, and operation generation that caused the effect. A later pathname read, similar provider row, recent receipt, caller-provided identifier, or HTTP success is not proof.

## Major completed systems

### Effect admission and verification

Canvas, Moodle, Blackboard, batch, and program-level operations now bind their authority to exact targets and exact postconditions. Uncertain writes stay uncertain. Failed or cancelled parent work cannot leave a child effect live. Create reconciliation uses the provider-returned identity attached to the spent effect receipt. Generic cross-target evidence no longer closes unrelated work.

Review [effect-broker.ts](../../packages/operation-journal/src/effect-broker.ts), [runtime.ts](../../packages/mcp-server/src/runtime.ts), [morrow-runtime.ts](../../packages/mcp-server/src/morrow-runtime.ts), and the provider operation modules before extending write behavior.

### Private and durable state

The shared state boundary now uses bounded no-follow reads, single-link and private-access checks, strict UTF-8, exact schema keys, canonical paths, process-start identity, durable atomic replacement, exact readback, and process-shared transactions. This control now protects Gateway state, learner-vault state, Blackboard credentials and receipts, local-owner descriptors and maintenance leases, Desktop records, update attempts, and assistant configuration.

Review [private-state-file.ts](../../packages/gateway-core/src/private-state-file.ts), [private-sqlite-state.ts](../../packages/gateway-core/src/private-sqlite-state.ts), [exact-trust-file.ts](../../packages/mcp-server/src/exact-trust-file.ts), and [strict-utf8.cjs](../../installer/shared/strict-utf8.cjs) before adding another trust file. Do not add a new ad hoc JSON reader for authority-bearing state.

### Bridge and MCP lifecycle

The Bridge now binds pairing, catalog compatibility, consent, course generation, cancellation, and update maintenance to exact live state. Provider responses have header and body deadlines, strict UTF-8, exact byte limits, and best-effort cancellation that never delays a terminal result. Binary WebSocket JSON is refused. Modern local-owner cancellation reaches the active request. Owner, upstream, test, smoke, and launcher process trees have bounded teardown.

Review [catalog-compatibility.js](../../connector/extension/src/catalog-compatibility.js), [service-worker.js](../../connector/extension/src/service-worker.js), [local-owner.ts](../../packages/mcp-server/src/local-owner.ts), [strict-stdio.ts](../../packages/mcp-server/src/strict-stdio.ts), and [owned-process.mjs](../../scripts/lib/owned-process.mjs) before adding a new transport path.

### Provider contracts and privacy

The Canvas readback plan, New Quiz contracts, Item Bank boundary, Moodle exact integer contract, Moodle private roster routes, and Blackboard 4000.21.0 contract now have explicit checked-in evidence. Privacy projection uses complete course-scoped identity data and does not infer identity from scalar equality. Saved result artifacts retain the immutable privacy projection needed for later reads.

Provider additions must update the shared contract source, generated artifacts, runtime admission, Bridge execution, exact readback, privacy type, and conformance tests in the same change.

### Desktop installation and updates

Desktop setup now binds assistant identity, selected material roots, Bridge delivery, runtime ownership, update generation, rollback, removal, and retained data to exact durable receipts. Updater events cannot make an artifact ready before its matching staging promise succeeds. Bridge swaps recover from every recorded cut point. Native smoke evidence binds the retained package and source graph.

Review [installer-controller.cjs](../../installer/shared/installer-controller.cjs), [bridge-updates.cjs](../../installer/shared/bridge-updates.cjs), [updates.cjs](../../installer/shared/updates.cjs), [packager-admission.cjs](../../installer/shared/packager-admission.cjs), and [runtime-monitor.mjs](../../installer/shared/runtime-monitor.mjs) before changing Desktop lifecycle order.

### Release and repository controls

CI runs the generated checks, repository tests, real Bridge browser harnesses, and Desktop suites on a pinned Node version. Release evidence now binds post-transform package bytes, dependency materialization, source rights, source origin, provider proof requirements, native smoke, and deterministic rebuild. GitHub `main` protection now requires the exact `check` check from GitHub Actions app ID `15368`, a current branch, one approval, stale-review dismissal, administrator enforcement, and resolved review conversations. Force pushes and deletion remain disabled.

## Verification completed before commit

- `pnpm check` passed from a clean command start. Both dependency audits reported no known vulnerability at the configured moderate threshold. Generated Canvas and Moodle contracts were current. All workspace builds passed.
- Package tests passed, including 677 Gateway tests, 251 Blackboard tests, 124 Gateway Core tests, 61 Canvas Connector tests, and every other package suite.
- Repository script tests passed 878 tests with one expected platform skip.
- Desktop tests passed 386 tests with the one expected native Windows access-control skip.
- The Desktop update harness passed all 7 tests.
- `pnpm test:browser` passed the full Canvas Connector browser flow and the unattended Bridge maintenance flow in Chrome for Testing. The run recorded the attended optional Chrome file-permission proof and native Windows smoke as not run by this command.
- `pnpm --dir installer --ignore-workspace test:bounded:suite` passed 386 Desktop tests with the expected Windows access-control skip under its suite deadline.
- `pnpm --dir installer --ignore-workspace test:layout` passed at 1180, 1000, 900, 760, 700, 440, and 320 pixels. It also passed focus restoration, busy-state, disclosure-state, macOS, and Windows rendering checks.
- The focused provider response boundary passed all 11 strict-byte, deadline, and cancellation regressions.
- GitHub branch-protection readback returned `strict: true`, required check `check` with app ID `15368`, `enforce_admins: true`, `required_conversation_resolution: true`, one required approval, stale-review dismissal enabled, force pushes disabled, and deletion disabled.
- `git diff --check` passed before the final commit.

## Attention required next

### 1. Repair defect 311 first

[runtime-monitor.mjs](../../installer/shared/runtime-monitor.mjs) directly awaits MCP initialization, health, course binding discovery, first safe read, diagnostic tool listing, diagnostic resource reading, client close, and transport close. Those operations have no monitor-owned deadline. A local peer can accept work and then stop settling it. Desktop startup, refresh, first read, diagnostics, or shutdown can then wait forever.

Implement one reusable Desktop MCP operation boundary. Give initialization, local status, provider first read, diagnostics, and shutdown explicit limits that match their work. Pass the operation signal into each MCP SDK call that accepts it. Race settlement so a peer that ignores cancellation cannot retain the Desktop call. On failure, close the exact client and transport generation, reclaim its child process tree, clear monitor state, and allow a healthy reconnect.

Add a fixture that completes initialization and selectively stalls each later operation. Prove that every public monitor method settles within its contract, reports the fixed unavailable state, closes the stalled generation, leaves no child process, and reconnects to a healthy replacement. Add a source guard that rejects a direct unbounded MCP SDK request in this module.

### 2. Run native Windows proof

Run the manual `desktop-release.yml` workflow on `windows-2022`. Require the retained NSIS installer, installed ASAR source graph, runtime health, startup stages, owner descriptor DACL, assistant configuration, update flow, upgrade from the exact prior artifact, uninstall retention, and process-tree cleanup to pass in one bound run. Treat the local Windows ACL skip as a gap until that workflow succeeds for this branch commit.

The private file and transaction changes need special attention on NTFS. Verify no-follow behavior, DACL admission, atomic replacement, directory durability assumptions, hard-link claim recovery, process start-time matching, canonical path handling, and `taskkill` tree reclamation on native Windows.

### 3. Run signed macOS installation and update proof

Build the Apple silicon DMG and ZIP from the retained package graph. Sign with the intended Developer ID, notarize, staple, install from the DMG, and run the packaged smoke against the installed app. Then publish a private update feed for the same source graph and prove download, signature verification, staging, restart handoff, post-repair runtime verification, and rollback reporting.

The local suite proves the state machine. It does not prove Gatekeeper, notarization, mounted-volume behavior, real application replacement, or the signed `electron-updater` handoff.

### 4. Complete attended Chrome permission proof

Run `pnpm test:browser:attended` from a visible terminal. Answer Chrome's own optional course-file permission prompts. Retain the receipt for the exact branch commit. Confirm grant, denial, revocation, persisted opt-in mismatch, file read, and disconnect behavior in the installed Bridge.

### 5. Run provider-specific live proof

Use dedicated test courses and explicit reviewed changes. Keep each provider receipt separate.

- Canvas: verify course discovery, one read, private roster projection, Classic Quiz repair, New Quiz guarded edit, file permission, file upload, and each Item Bank write class with exact provider readback. No live Item Bank write is proved by the local conformance suite.
- Moodle: verify the complete public operation catalog against a supported live Moodle version. Include a site whose identifiers exercise the configured exact-number boundary. Verify private roster completeness, Forum export, file lifecycle, backup/import, Question Bank phases, groups, restrictions, reports, and uncertain-write recovery.
- Blackboard: run the 4000.21.0 contract against a real test tenant. Verify OAuth identity, account and course binding, learner privacy, assignment and grade-column identity, groups, announcements, file handling, durable effect receipts, recovery after lost responses, and process-shared state. Current documentation correctly states that no live Blackboard tenant has been tested.

For every live write, bind the exact test target before dispatch. Use fresh authoritative provider readback after the write. Preserve unknown outcomes. Never retry a dispatched uncertain write by default.

### 6. Complete the release evidence graph

After native and live proofs exist, regenerate source origin and source rights from the final source commit. Build every selected public profile from frozen dependencies. Verify the deterministic rebuild from the retained source checkpoint. Generate the final SBOM and candidate-set receipt. Run signing preflight. Inspect the exact public archives and Desktop installers. Publish only after every selected provider and platform requirement is satisfied by current content-addressed evidence.

### 7. Require green remote CI before integration

After the branch is pushed, wait for the remote `check` run on the branch commit. Inspect the failed step and artifact if GitHub differs from this Mac. Open a pull request into `main`. The newly enforced branch rule requires current green CI, one approval, stale-review dismissal, administrator enforcement, and resolved review conversations.

## Resume commands

```sh
git fetch origin
git switch codex/defect-root-eradication
pnpm install --frozen-lockfile
pnpm --dir installer --ignore-workspace install --frozen-lockfile
pnpm check
pnpm test:browser
pnpm --dir installer --ignore-workspace test:bounded:suite
pnpm --dir installer --ignore-workspace test:layout
git diff --check
```

Start with defect 311. Keep its repair on this branch or a branch based on this exact delivery head. Update the ledger with the regression and broad evidence. Then continue with the native and live proof sequence above.
