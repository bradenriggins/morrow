# Morrow: building accountable AI course operations

**Status:** Private portfolio and recruiter draft.

## The problem

AI can generate a lesson, quiz question, or course update quickly. Course teams still need answers to harder questions: Which account and course will change? What exactly did the reviewer approve? What did the LMS save? What should happen when a request becomes stale or its result is uncertain?

Morrow is my answer to that problem. It is a local course-operations layer for AI-assisted LMS work. Its core loop is **request → review → approval → saved result**. The product makes the work inspectable instead of treating a chat response or provider response as the end of the workflow.

The operating model can span providers, while each provider keeps its own setup, available operations, and evidence boundary. Canvas uses a signed-in Chrome connector. Moodle and Blackboard use separate private API connections.

## My role

I created Morrow and led its product direction over months of work. I defined the course-operation model, the evidence standard, the proof workflow, and the launch narrative. I led work across product design, interaction design, technical implementation, testing direction, and validation.

This independent build combines product design, AI-assisted engineering, and live LMS workflow validation.

## The product thesis

Morrow does not add another chat interface. An AI client supplies intent. Morrow holds the conditions around the provider operation:

```text
AI request
  → bound account, course, provider, and target
  → readable local review
  → one human approval of a frozen request
  → provider dispatch
  → fresh readback and an evidence-backed result
```

The operating record is the product. It preserves a human decision, the exact requested change, and a truthful result when the system cannot establish an effect.

## System design

**Bound context.** The Canvas page-correction path reads the course, page, and latest revision before planning. It checks the body hash, page settings, revision consistency, and one unique visible-text anchor. A changed target requires a new review. [Page-correction source](../packages/mcp-server/src/page-correction.ts)

**Readable review.** The local approval flow shows current and proposed content instead of raw request data alone. It sanitizes executable elements and external media, so the reviewer can assess a concrete change and its preserved conditions.

**Human approval.** The dispatcher sends only a frozen, approved operation. A correction is a new, separately approved operation, not a replay of the original request. [Operation tools](../packages/mcp-server/src/operation-tools.ts)

**Verification and recovery.** Verification compares a frozen expected result with fresh provider evidence. Reconciliation runs readback without replaying a provider request. Ambiguous delivery remains visible rather than becoming a fabricated success.

**Controlled batches.** Batch records carry explicit course sets, dependencies, source bindings, observation digests, and readback specifications. The approved manifest fixes concurrency and rate controls. Recovery never retries an uncertain write. [Batch tools](../packages/mcp-server/src/batch-tools.ts)

**Source-linked review.** For one Canvas lesson and New Quiz, Morrow requests two independent specialist reviews and a separate checker. Findings must cite exact source and target text from captured evidence. The result requires educator review; it does not claim verified teaching quality. [Lesson-review source](../packages/mcp-server/src/lesson-review.ts)

## Hard product decisions

1. Build an operations layer, not a chatbot, so the AI client stays replaceable while provider authority and verification stay with the course operation.
2. Make review a product surface: exact before-and-after, target, preserved conditions, and result state.
3. Refuse stale work instead of silently writing against old evidence.
4. Treat uncertainty as a first-class result. A provider response alone is not proof, and ambiguous writes do not replay automatically.
5. Keep provider claims separate. Canvas evidence does not become Moodle or Blackboard evidence.

## Evidence at a glance

| Evidence category | Current factual support |
| --- | --- |
| Implemented local code | The current local code includes governed operations, local approval, Canvas connection, bounded batches, source-linked review, and provider-specific scopes. Installed-client and live-provider results are recorded separately. |
| Full static gate | The final canonical-URL source passed 159 workspace tests and 21 script tests: 180 tests total. |
| Selected live Canvas proof | A lesson correction, narrow New Quiz key correction, two module-link writes, three publication operations, and one Student View learner route reached verified evidence. A stale page proposal failed before send and later page readback showed no effect. |
| Native client read | The installed Codex CLI connected to Morrow, resolved the sandbox binding, and read the exact published New Quiz through the actual tool. Only three read tools were exposed. |
| Moodle scope | Six tools: five reads and one course-summary write. Official API and test validation only. |
| Blackboard scope | Six tools: five reads, including direct Ultra child discovery, and one document update. Official API and test validation only. |
| Illustrative film | The local site and film show workflow and visual direction. They do not establish a live LMS result. |

## Current Canvas proof

The Canvas record now shows a connected evidence chain.

An educator-provided source exposed a planted lesson error and a wrong saved New Quiz answer key through two independent specialist requests and a separate checker. The source-review exchange used a manual MCP host adapter.

An approved lesson correction reached verified page readback. One phrase changed while title, URL, publication state, front-page state, and editing roles remained unchanged. A later proposal with a stale pre-change condition failed before send. The following page read showed the same body and update time.

The New Quiz correction then reached `verified` with one dispatch attempt. The before-and-after item comparison showed that only question one’s saved scoring value and update time changed; all other question fields stayed unchanged. Two module-link writes and three publication operations also reached verified state. The later module readback contained both the lesson and quiz.

In Canvas Student View, the published lesson displayed the corrected text. `Next Module Item` launched the quiz. `Begin` showed all three questions. After correct selections were submitted, the assessment result showed 100%, three of three points, the correct ribosomes answer, and all three feedback messages. This proves one selected sandbox learner route.

## Verification limits

Native AI-client sampling remains unproven beyond the manual MCP host adapter. Independent clean-machine reproduction remains open. Moodle and Blackboard have no live tenant evidence. The selected Canvas sandbox sequence does not establish a full Canvas catalog, every learner flow, learning effectiveness, or whole-release verification. A separate page-creation test is under investigation. Morrow has no public deployment or institutional-use claim.

## Role families this work fits

- AI education product lead or technical product manager.
- Learning-platform integrations or LMS product manager.
- Agentic systems, workflow reliability, or applied AI product engineer.
- Forward-deployed, solutions, or implementation product roles for education technology.
- Product roles that connect educator workflow, platform APIs, safety controls, and evidence design.

These are role families, not a claim of eligibility for a specific opening.

## 90-second interview walkthrough

“I created Morrow because generated course content is not enough for instructional teams. A real course change has a target, permissions, related assessments, and learner consequences. I spent months building the operations layer around that work.

“The core loop is request, review, approval, and saved result. Morrow binds an AI request to the account, course, provider, and exact record. It shows the current and proposed values in a local review. A person approves one saved request. Then Morrow reads the LMS again and reports verified, unconfirmed, or failed.

“The key design decision was to make uncertainty a product state. In one live Canvas sandbox sequence, we verified a lesson correction, a narrowly scoped quiz-key correction, module links, publication, and a Student View path through a three-question quiz to a three-point result with feedback. We also tested a stale proposal: it failed before send, and the next read proved the page had not changed. That safe failure is as important as the success cases.

“The work is provider-specific. Canvas has selected sandbox proof through a browser connector. Moodle and Blackboard have narrower API and test scopes, with no live-tenant claim. This is not whole-release verification. The value of the work is product judgment: I built a system that makes AI course operations accountable before it calls them complete.”

## Evidence sources

- [README.md](../README.md): local architecture, client boundary, connector model, provider scope, and release status.
- [BT2-LIVE-PROOF.md](../docs/implementation/BT2-LIVE-PROOF.md): recorded Canvas operation receipts and proof scope.
- [Page correction source](../packages/mcp-server/src/page-correction.ts): page binding, revision guard, preserved fields, and exact-text planning.
- [Operation tools](../packages/mcp-server/src/operation-tools.ts): frozen approved dispatch, readback-only reconciliation, and separate correction operations.
- [Batch tools](../packages/mcp-server/src/batch-tools.ts): bounded manifests, verified child readback, and no retry of uncertain writes.
- [Lesson review source](../packages/mcp-server/src/lesson-review.ts): two independent reviewers, separate checker, quotation validation, and educator-review limits.
