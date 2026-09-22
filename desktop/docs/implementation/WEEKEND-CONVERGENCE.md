# Weekend convergence implementation

This record maps Revision 3 of the weekend plan to the standalone Morrow implementation.

Revision 3 calls for reusing working Morrow and ExamplePlatform capabilities. The later product direction changes the installation boundary to a local MCP component and a Chrome connector. Neither legacy runtime is a required user installation.

The current standalone architecture does not, by itself, prove that all required behavior has been carried over. A generated Canvas API catalog is not evidence of complete instructional-design workflows. The full weekend goal remains open until the requirements and user paths below have current proof.

## Product target

| Plan requirement | Current implementation |
|---|---|
| One MCP server | `@morrow-lms/gateway` is the only client-facing server. |
| Generated catalog | 1,118 official Canvas operations plus 16 explicit Item Bank operations and one private course-file read. |
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

One rule decides step 11 for a Canvas write the provider did not accept. A 4xx other than 408 and 429 is a refusal Canvas saved nothing from, so the record is failed and the course item stays free for another attempt. A 5xx, a 408, a 429, and any lost or unreadable response stay uncertain, so the record is applied-or-unknown and Morrow never sends that change again. The uncertain half is proved against fixtures only; a real Canvas 5xx after a committed write is live-unverified. A Moodle form post keeps its own test, because a Moodle validation page can follow a change that was already saved.

## Connector protocol

The extension initiates the WebSocket because Chrome service workers cannot accept local inbound connections. The loopback server binds only to `127.0.0.1`. Pairing uses a local approval page and a high-entropy secret sent in the first WebSocket message, not in a URL.

Commands carry protocol version, request ID, operation ID, generation, exact operation key, exact source binding, expiry, arguments, and outer grant. Results carry matching identity and bounded result or problem data.

The connector owns provider readback. This closes the false-verification gap that exists when a gateway trusts a write response without observing Canvas state. The comparison binds to exactly one record at the location the readback plan declares, and it compares the requested fields on that record only. Two matching records, no matching record, a field the provider did not return, or a value that matches only after coercion reports `mismatch` or `unconfirmed`, never `verified`.

## New Quizzes and Item Banks

Official New Quizzes routes are generated from Canvas definitions. Every New Quizzes `POST` and `PATCH` uses a JSON request body, not only the two item routes. This preserves nested `interaction_data`, answer structures, and `scoring_data`, and it matches the only harvested client evidence there is for that separate service. No connected Canvas tenant has run a New Quizzes write with either encoding, so the encoding is live-unverified in both directions.

A change to `quiz_settings` never sends part of the block. The connector reads the quiz, refuses the change when the current settings differ from the digest the caller read them at, merges the requested change into the current settings at the leaf level, sends the complete block, and reports which keys it carried over. A quiz it cannot read stops the change; it is not a warning. A change to the title, instructions, dates, or points of a quiz touches no setting and reads nothing first.

The Item Bank contract defines sixteen signed-browser operations: seven reads and nine owner-write shapes. All nine writes stop before provider I/O. Bank creation lacks a proved recoverable create-and-course-associate transaction. Rename, archive, item create or update, item attach, entry removal, and course sharing lack complete downstream reach. The quiz bank draw lacks durable recovery after a browser worker or process interruption. Its admitted read requires the exact selected assignment, a fresh builder credential, one verified private quiz id, and numbered quiz-entry pages through an empty end page. Secret-shaped keys never leave the browser execution boundary.

`morrow_plan_item_bank_question_image_alt_repair` depends on the held generic item-update shape and stops before a bank read or PATCH. A standing Edit grant or acknowledgement of observed fan-out rows cannot override the hold. Stimuli and unresolved entries remain blocked.

The fan-out reader reports entry counts, observed share rows, and quiz uses from selected connected courses. Current share rows use a private context UUID, which Morrow cannot map to a numeric Canvas course id from proved data. It always stays incomplete because Canvas exposes no authoritative account-wide reverse lookup. It is review context and does not grant write authority. No live bank has answered any private route from this release.

## Batches

Batch creation accepts only an explicit complete course set for writes. It freezes child order, course IDs, tool names, source bindings, argument digests, dependencies, catalog digest, profile digest, approval coverage, request estimate, rate policy, expiry, readback digests, and correction facts.

One approval page shows every child. One click now starts approved execution and shows progress and final status on that page. Single operations use the existing effect dispatcher. Write batches use bounded windows through the same scheduler as MCP tools; no typed Continue is needed. Each child still receives a separate effect record and receipt. The scheduler limits active windows and per-batch concurrency. Two read groups run at the same time while their frozen request rates fit inside the shared Bridge limit of eight requests at once; a group frozen at that whole limit runs on its own. A write group runs alone, with no other group beside it. A run that waits for a window another group holds waits at most 60 seconds. Morrow then refuses that run and names the group that holds the window, when that group started, and the assistant session that asked for it. Cancelling the request removes the waiting run at once, at most 32 runs may wait, and `morrow_batch_health` lists the running and waiting groups. Two runs of one group still take turns without a deadline. Approved work started from the approval page also waits without a deadline. It records every child independently and exposes bounded result pages. Automatic continuation stops on uncertain outcomes before the next group of requests. Closing the local runtime also stops unsent work during a rate-limit delay. Sent work remains subject to saved-state recovery. Automatic chat continuation and embedded chat reviews remain unimplemented and unverified.

A run no longer stays silent until it returns. When the caller supplies a progress token, `morrow_batch_run` and `morrow_batch_resume` send one MCP progress notification for each child that run finishes: the children the group has settled, including the ones earlier windows settled, the children the group froze, and one sentence naming the course and its outcome. The sentence is built from the frozen manifest and the settled child state, never from a provider result, so no learner identity reaches it. A caller that supplies no progress token sees no change. Whether an assistant displays the notifications is that assistant's own behaviour.

Recovery distinguishes safe queued work from an interrupted or uncertain provider effect. The latter moves to inspection or readback. It is never sent again automatically.

One tool answers what every assistant is doing now. `morrow_activity` reads Morrow's own saved state, the window scheduler, and the Bridge status the connector already holds; it sends nothing to a learning platform. It names each connected assistant session, by the name that assistant reported and never as proof of identity, and says which session holds a batch window. It lists the groups that run and wait with their mode, holder, start or queue time, and how many children are done, uncertain, and still to run. It lists every saved change that still holds a course item with its operation, tool, course, state, and attention, and separates the changes only a person can close. It reports whether the Bridge is connected, its generation, extension, and catalog digest, and each connected site with whether that site's course connections are verified. Results pass the same egress boundary as every other tool, and no project path is returned. The public and full tool surfaces both expose it; the public surface has no request groups and says so rather than reporting an idle scheduler.

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
| New Quizzes and Item Banks | Live question, bank, and quiz-draw operations; scoring and ordering readback; and learner-access checks for each advertised workflow. The private routes have local proof only. |
| Actual Chrome connection, section 8 | Identify and test the new connector in the user's regular signed-in profile. The temporary test browser does not prove that installation. |
| Live operation and batch path, sections 12.4 and 14 | Current disposable-target reads, plans, reviews, single sends, fresh comparisons, interruptions, corrections, and cleanup through the new MCP and connector. |
| Client parity and installation, sections 14.7 and 17 | Complete the eleven-step scenario in each advertised client. Reproduce the candidate on an independent clean machine. |
| Release and claims, sections 15 and 17 | Rebuild the exact candidate, attach current receipts, and obtain publication authorization. Do not label synthetic test results as live compatibility or a completed product. |
