# Morrow: building reviewed course work with AI assistance

**Status:** Private portfolio and recruiter draft.

## The problem

AI assistance can prepare a lesson, quiz question, or course update. Course teams still need answers to harder questions: Which account and course will change? What exactly did the reviewer approve? What did the LMS save? What should happen when a request becomes stale or its result is uncertain?

Morrow is my answer to that problem. It is a local product for course work that uses AI assistance. Its core loop is **request → review → approval → checked result**. The product makes the work inspectable instead of treating a chat response or LMS response as the end of the workflow.

The operating model can span providers, while each provider keeps its own setup, available operations, and evidence boundary. Canvas uses a signed-in Chrome connector. Moodle and Blackboard use separate private API connections.

## My role

I created Morrow and led its product direction through months of work. I defined the course-work model, the evidence standard, the proof workflow, and the launch narrative. I led work across product design, interaction design, implementation, testing direction, and validation.

This creator-led product build combines product design, AI-assisted engineering, and selected live LMS workflow validation. The live evidence remains separate from local implementation and test evidence.

## The product thesis

Morrow does not add another chat interface. A compatible assistant supplies the request. Morrow holds the conditions around the LMS change:

```text
Course request from a compatible assistant
  → bound account, course, provider, and target
  → readable local review
  → one human approval of a frozen request
  → one LMS dispatch attempt
  → fresh readback and a checked result
```

The operating record is the product. It preserves a human decision, the exact requested change, and a truthful result when the system cannot establish an effect.

## System design

**Bound context.** The Canvas page-correction flow reads the course, page, and latest revision before planning. It checks the body, page settings, revision consistency, and one unique visible-text anchor. A changed target requires a new review.

**Readable review.** The local approval flow shows current and proposed content instead of raw request data alone. It sanitizes executable elements and external media, so the reviewer can assess a concrete change and its preserved conditions.

**Human approval.** The dispatcher sends only a frozen, approved operation. A correction is a new, separately approved operation. It is not a replay of the original request.

**Verification and recovery.** Verification compares a frozen expected result with fresh provider evidence. Reconciliation runs readback without replaying a provider request. Ambiguous delivery remains visible rather than becoming a fabricated success.

**Controlled batches.** Batch records carry explicit course sets, dependencies, source bindings, and readback requirements. The approved plan sets the order and rate controls. Recovery never retries an uncertain write.

**Source-linked review.** For one Canvas lesson and New Quiz, Morrow requests two independent specialist reviews and a separate checker. Findings must cite exact source and target text from captured evidence. The result requires educator review. It does not claim verified teaching quality.

**Specific privacy boundary.** Canvas sign-in stays in Chrome. Credentials stay out of assistant messages and saved records. Morrow blocks credential and learner fields from assistant output. The selected course text and metadata needed for a request can reach the chosen assistant under that assistant's own account settings and data terms.

## Hard product decisions

1. Build a clear course-work process around the assistant conversation, so the educator can see the target, approve the proposed change, and check the saved result.
2. Make review a product surface: exact before-and-after, target, preserved conditions, and result state.
3. Refuse stale work instead of silently writing against old evidence.
4. Treat uncertainty as a first-class result. A provider response alone is not proof, and ambiguous writes do not replay automatically.
5. Keep platform and assistant claims separate. Canvas evidence does not become Moodle or Blackboard evidence. The selected Codex route does not become proof for every assistant configuration.

## Evidence at a glance

| Evidence category | Current factual support |
| --- | --- |
| Implemented local code | The current local code includes governed operations, local approval, Canvas connection, bounded batches, source-linked review, and provider-specific scopes. Installed-client and live-provider results are recorded separately. |
| Full static gate | The final canonical-URL source passed 159 workspace tests and 21 script tests: 180 tests total. |
| Selected live Canvas proof | A lesson correction, narrow New Quiz key correction, two module-link writes, three publication operations, and one Student View learner route reached verified evidence. A stale page proposal failed before send and later page readback showed no effect. |
| Selected Codex route | The installed Codex CLI read the published New Quiz. In a separate interactive test, native tool approval staged a page update; Morrow approval led to one verified dispatch. Native and independent later reads confirmed the exact change and unchanged protected fields. This is one selected route only. |
| Moodle scope | Six tools: five reads and one course-summary write. Official API and test validation only. |
| Blackboard scope | Six tools: five reads, including direct Ultra child discovery, and one document update. Official API and test validation only. |
| Illustrative film | The local site and film show workflow and visual direction. They do not establish a live LMS result. |

## Current Canvas proof

The Canvas record now shows a connected evidence chain.

An educator-provided source exposed a planted lesson error and a wrong saved New Quiz answer key through two independent specialist requests and a separate checker. The source-review exchange used a manual MCP host adapter.

An approved lesson correction reached verified page readback. One phrase changed while title, URL, publication state, front-page state, and editing roles remained unchanged. A later proposal with a stale pre-change condition failed before send. The following page read showed the same body and update time.

The New Quiz correction then reached `verified` with one dispatch attempt. The before-and-after item comparison showed that only question one’s saved scoring value and update time changed; all other question fields stayed unchanged. Two module-link writes and three publication operations also reached verified state. The later module readback contained both the lesson and quiz.

In Canvas Student View, the published lesson displayed the corrected text. `Next Module Item` launched the quiz. `Begin` showed all three questions. After correct selections were submitted, the assessment result showed 100%, three of three points, the correct ribosomes answer, and all three feedback messages. This proves one selected sandbox learner route.

A separate unpublished page creation reached automatic verification after one dispatch. An independent read confirmed its exact identity, content, and saved settings. The installed Codex interactive client then prepared a one-paragraph update on another sandbox page. Native tool approval staged the request; Morrow showed its current and proposed content for separate approval. One dispatch reached verified state. Both the native client and a later independent read confirmed the exact append and unchanged protected fields.

## Verification limits

Automatic assistant sampling remains unproven beyond the manual adapter. Independent clean-machine reproduction remains open. Moodle and Blackboard have no live tenant evidence. The selected Canvas sandbox sequence does not establish a full Canvas catalog, every learner flow, learning effectiveness, or whole-release verification. Morrow has no public deployment or institutional-use claim.

## Role families this work fits

- AI and education product lead or technical product manager.
- Learning-platform integrations or LMS product manager.
- Agentic systems, workflow reliability, or applied AI product engineer.
- Forward-deployed, solutions, or implementation product roles for education technology.
- Product roles that connect educator workflow, platform APIs, safety controls, and evidence design.

These are role families, not a claim of eligibility for a specific opening.

## 90-second interview walkthrough

“I created Morrow because generated course content is not enough for instructional teams. A real course change has a target, permissions, related assessments, and learner consequences. I spent months building a clear process around that work.

“The core loop is request, review, approval, and checked result. Morrow binds a course request from a compatible assistant to the account, course, platform, and exact record. It shows the current and proposed values in a local review. A person approves one saved request. Then Morrow reads the LMS again and reports verified, unconfirmed, or failed.

“The key design decision was to make uncertainty a product state. In one live Canvas sandbox sequence, we verified a lesson correction, a narrowly scoped quiz-key correction, module links, publication, and a Student View path through a three-question quiz to a three-point result with feedback. We also tested a stale proposal: it failed before send, and the next read proved the page had not changed. That safe failure is as important as the success cases.

“The work is platform-specific. Canvas has selected sandbox proof through a browser connector. Moodle and Blackboard have narrower API and test scopes, with no live-tenant claim. The selected Codex route is not universal assistant proof. This is not whole-release verification. The value of the work is product judgment: I built a system that makes AI-assisted course changes reviewable before it calls them complete.”

## Evidence sources

- Morrow product overview: local architecture, assistant boundary, platform scope, and release status.
- Canvas proof record: recorded operation receipts and proof scope for the selected sandbox.
- Implementation review: page binding, revision guard, frozen approval, readback-only reconciliation, bounded batches, and educator-review limits.
