# Weekend convergence implementation

This record maps Revision 3 of the weekend plan to the standalone Morrow implementation.

Revision 3 calls for reusing working Morrow and ExamplePlatform capabilities. The later product direction changes the installation boundary to a local MCP component and a Chrome connector. Neither legacy runtime is a required user installation.

The current standalone architecture does not, by itself, prove that all required behavior has been carried over. A generated Canvas API catalog is not evidence of complete instructional-design workflows. The full weekend goal remains open until the requirements and user paths below have current proof.

## Product target

| Plan requirement | Current implementation |
|---|---|
| One MCP server | `@morrow-lms/gateway` is the only client-facing server. |
| Generated catalog | 1,118 official Canvas operations plus 12 explicit Item Bank operations. |
| Explicit row disposition | Every row has route, profile, authority, privacy, risk, and evidence metadata. |
| Governed reads and writes | All generated calls pass through the Morrow result and authority boundary. |
| Restart-safe cross-course work | SQLite operation and batch journals retain child truth and uncertain effects. |
| Client configuration | Codex, Claude Code, Claude desktop chat, and Gemini CLI configs resolve to the same stdio server. Full live client scenarios remain unverified. |
| Provider exclusion | MindTap and Connect are denied by catalog generation, gateway filters, and package scans. |
| Private and public packages | Deterministic private/full and public/Canvas package profiles exist. |
| Browser-only operations | The directly owned Chrome connector uses the signed-in Canvas session. |
| Coordinated specialist work | `morrow_review_lesson` makes separate lesson and quiz model requests, then asks a checker to assess each finding. It preserves source quotes, disagreements, and limits. Synthetic SDK tests pass. Real client/model proof and coordinated course changes remain open. Development review agents are not product evidence. |
| Moodle and Blackboard | The private/full gateway includes a bundled REST source. It reads course information and supports a Moodle course-description change or a Blackboard document change through the existing review and verification path. Educator setup and live account proof remain open. |

## Operation lifecycle

The browser lifecycle below describes Canvas. Moodle and Blackboard use saved private REST connections. Their writes check the connected account and current item snapshot, use the same local approval and durable effect journal, send once, and check fresh provider data. These connections do not require Chrome to remain open. See [the implementation checkpoint](MULTI-LMS-AND-LESSON-REVIEW.md) for their exact scope.

### Read

1. Validate the generated tool schema.
2. Select the exact current browser binding.
3. Validate origin, principal fingerprint, course, and connection generation.
4. Execute the generated request in Chrome.
5. Project and bound the provider response.
6. Return `morrow.result.v1` with catalog and source evidence.

### Write

1. Validate the schema and exact source binding.
2. Derive a safe operation-specific readback.
3. Freeze the request, targets, profile, catalog, account, principal, generation, risk, expiry, and comparator.
4. Write the plan to the durable effect journal.
5. Return the operation ID, plan digest, and local approval URL.
6. Accept human approval only through the nonce-bound loopback page.
7. Recompute authority at dispatch.
8. Reserve and consume one effect receipt.
9. Send one provider request through the connector.
10. Perform fresh provider readback in the connector.
11. Record verified, unconfirmed, failed, or applied-or-unknown state.

Morrow never creates approval through MCP. It never treats dispatch or HTTP success as proof of final state. It never automatically replays an ambiguous write.

## Connector protocol

The extension initiates the WebSocket because Chrome service workers cannot accept local inbound connections. The loopback server binds only to `127.0.0.1`. Pairing uses a local approval page and a high-entropy secret sent in the first WebSocket message, not in a URL.

Commands carry protocol version, request ID, operation ID, generation, exact operation key, exact source binding, expiry, arguments, and outer grant. Results carry matching identity and bounded result or problem data.

The connector owns provider readback. This closes the false-verification gap that exists when a gateway trusts a write response without observing Canvas state.

## New Quizzes and Item Banks

Official New Quizzes routes are generated from Canvas definitions. New Quiz item create and update use JSON request bodies. This preserves nested `interaction_data`, answer structures, and `scoring_data`.

The Item Bank contract defines twelve signed-browser operations. The in-page executor covers all methods, paths, queries, and bodies. It rejects a wrong origin, referrer, course, principal, token, path, or catalog key before network dispatch. It strips secret-shaped keys from returned objects. The New Quizzes token stays in the frame's main world.

Bank creation enters the same plan, approval, receipt, dispatch, and verification lifecycle as an official Canvas write. Six changes to existing banks remain disabled until Morrow can establish their dependencies and affected courses. The twelve request contracts do not prove complete Item Bank support.

## Batches

Batch creation accepts only an explicit complete course set for writes. It freezes child order, course IDs, tool names, source bindings, argument digests, dependencies, catalog digest, profile digest, approval coverage, request estimate, rate policy, expiry, readback digests, and correction facts.

One approval page shows every child. One click now starts approved execution and shows progress and final status on that page. Single operations use the existing effect dispatcher. Write batches use bounded windows through the same scheduler as MCP tools; no typed Continue is needed. Each child still receives a separate effect record and receipt. The scheduler limits active windows and per-batch concurrency. It records every child independently and exposes bounded result pages. Automatic continuation stops on uncertain outcomes before the next group of requests. Closing the local runtime also stops unsent work during a rate-limit delay. Sent work remains subject to saved-state recovery. Automatic chat continuation and embedded chat reviews remain unimplemented and unverified.

Recovery distinguishes safe queued work from an interrupted or uncertain provider effect. The latter moves to inspection or readback. It is never sent again automatically.

## Privacy

The gateway projects data before redaction. Policy controls fields, record count, byte count, free text, artifacts, and AI-client admission. Learner identifiers map to stable local opaque tokens. The vault is separate from output. Nested provider errors and logs are scrubbed.

The connector never returns Canvas passwords, cookies, CSRF values, session tokens, Item Bank tokens, raw pairing secrets, or Chrome tab IDs to the AI client.

## Packaging and client integration

The setup command writes an absolute local connector configuration. Client installation merges one Morrow stdio entry without replacing unrelated client settings. Configuration contains no provider credential.

The extension packager creates stable bytes from the exact manifest, popup, runtime modules, and generated catalog. Release profiles create deterministic source candidates, checksums, manifests, and CycloneDX SBOMs.

## Verification map

- CAT: deterministic generation, unique names and keys, exact integer IDs, profile disposition, held-provider scan.
- MCP: protocol eras, malformed input, bounded result handles, strict stdio, disconnect behavior.
- AUTH and APR: wrong origin, changed principal, stale generation, wrong nonce, expiry, replay, incomplete coverage.
- EFF and VER: pre-send failure, post-send uncertainty, idempotency conflict, no duplicate, mismatch, incomplete readback, correction conflict.
- BAT: 25 and 100 course execution, 10,000 child stress, failure, uncertainty, pause, cancel, altered target, restart, paging.
- PRIV: nested secrets, learner identity, hidden HTML, artifacts, logs, public package markers, private source refusal.
- CLIENT: equivalent server command, args, working directory, environment, and eleven-step scenario definition.
- CONNECTOR: pairing, binding, permissions, Canvas read/write, New Quiz JSON write, all Item Bank transports, readback, replay refusal, restart, disconnect, and packaging.

Live Canvas, real-client, independent-reproduction, source-rights, provider-policy, and publication receipts stay external and must remain explicit until completed.

## Remaining completion evidence

The native `morrow_plan_page_correction` workflow now freezes the complete page identity, body hash, metadata, latest revision, and one exact visible-text replacement. Bridge 1.0.1 constructs the new HTML from freshly checked source. It sends only the body field and verifies the full page, unchanged settings, and one new revision. Planning rejects filtered source. Dispatch rejects stale source before sending. Synthetic browser and MCP tests cover this path; live Canvas proof and automatic corrective undo remain open. This implements one bounded page workflow, not the full legacy page, project, evidence, or repair families.

The page URL catalog parameter now accepts Canvas slugs and explicit `page_id:` identifiers. It was incorrectly constrained to decimal IDs by the generic identifier rule. The API operation count is unchanged.

| Requirement | Evidence still required |
|---|---|
| Existing Morrow and ExamplePlatform workflow breadth, sections 2.4 and 5 | Source and execution parity for the required planners, course repair, projects, files, reports, evidence, workflows, and schedules. A larger API catalog does not satisfy this requirement. |
| New Quizzes and Item Banks | Live question and bank operations, affected-course checks, scoring and ordering readback, and learner-access checks for each advertised workflow. Existing-bank mutation holds must be resolved before claiming full support. |
| Actual Chrome connection, section 8 | Identify and test the new connector in the user's regular signed-in profile. The temporary test browser does not prove that installation. |
| Live operation and batch path, sections 12.4 and 14 | Current disposable-target reads, plans, reviews, single sends, fresh comparisons, interruptions, corrections, and cleanup through the new MCP and connector. |
| Client parity and installation, sections 14.7 and 17 | Complete the eleven-step scenario in each advertised client. Reproduce the candidate on an independent clean machine. |
| Release and claims, sections 15 and 17 | Rebuild the exact candidate, attach current receipts, and obtain publication authorization. Do not label synthetic test results as live compatibility or a completed product. |
