# Morrow: building reviewed course work with AI assistance

**Status:** Private portfolio and recruiter draft.

## The problem

AI assistance can prepare a lesson, quiz question, or course update. Course teams still need to know which course will change, what an educator approved, what the LMS saved, and what happens when the course changed during planning or the result is uncertain.

Morrow turns an assistant request into a reviewed course change and a checked LMS result. It shows the course, current content, and proposed edit before approval. An educator approves one change. Morrow then checks the LMS again and reports what it can confirm. If it cannot confirm the result, it marks the work for attention and does not repeat the change automatically.

Canvas and Moodle use the same signed-in Chrome connector. Canvas has selected live sandbox proof. Moodle test-course proof covers course reads; Page, Assignment, and Quiz creation without questions; editing Pages, Assignment instructions, and Quiz instructions; and setting or clearing Assignment due dates and Quiz open/close dates. Selected test-course work also covered Page and section visibility and reading Multiple choice and Essay questions. Question authoring, random and other question types, and changes to activities with attached files are not supported yet. Other activity types, section cases, and broader settings still need checks. Blackboard browser connection is not yet verified and Blackboard course work is unavailable. Each provider keeps its own evidence boundary.

## My role

I created Morrow and led its product direction through months of work. I defined the course-work model, the evidence standard, the proof workflow, and the launch narrative. I led work across product design, interaction design, implementation, testing direction, and validation.

This creator-led product build combines product design, AI-assisted engineering, and selected live LMS workflow validation. The live evidence remains separate from local implementation and test evidence.

## The product thesis

Morrow does not add another chat interface. An assistant set up with Morrow can prepare the request. Morrow keeps the educator's review, approval, and checked result clear.

    Assistant prepares one course update
      → Morrow shows the course, current content, and proposed edit
      → educator approves one reviewed change
      → Morrow sends that change once
      → Morrow checks the saved LMS record
          → confirmed: reports what the LMS saved
          → unconfirmed: marks it for attention and does not repeat it automatically

The record keeps the educator's decision, the requested change, and an honest result when the system cannot establish an effect.

## System design

**Right course, current content.** Before review, the Canvas page-correction flow checks the account, course, page, and latest content. It checks the page body, settings, revision consistency, and one unique visible-text anchor. A changed target requires a new review.

**Readable review.** The local approval flow shows current and proposed content instead of raw request data alone. It removes executable elements and external media, so the reviewer can assess a concrete change and the conditions that stay the same.

**One educator approval.** Morrow sends a change only after the educator approves the reviewed request. A correction is a new, separately approved request. It is not a repeat of the original request.

**Checked result and safe uncertainty.** Morrow compares the expected result with a new LMS check. When it cannot establish the effect, the result stays visible as unconfirmed. Morrow checks the named item again without repeating the provider request.

**Controlled batches.** Each batch names its courses, dependencies, and required checks. The approved plan sets the order and rate controls. Recovery never retries an uncertain change.

**Source-linked review.** For one Canvas lesson and New Quiz, Morrow requests two independent specialist reviews and a separate checker. Findings must cite exact source and target text from captured evidence. The result requires educator review. It does not claim verified teaching quality.

**Specific privacy boundary.** Canvas and Moodle sign-in stays in Chrome. Credentials stay out of assistant messages and saved records. Morrow blocks credential and learner fields from assistant output. The selected course text and metadata needed for a request can reach the chosen assistant under that assistant's own account settings and data terms.

## Hard product decisions

1. Build a clear course-work process around the assistant conversation, so the educator can see the target, approve the proposed change, and check the saved result.
2. Make review a product surface: exact before-and-after, target, preserved conditions, and result state.
3. Stop an outdated request instead of writing against old course content.
4. Treat uncertainty as a visible result. A provider response alone is not proof, and uncertain changes do not repeat automatically.
5. Keep platform and assistant claims separate. Canvas evidence does not become Moodle or Blackboard evidence. The selected Codex route does not become proof for every assistant configuration.

## Evidence at a glance

| Evidence category | Current factual support |
| --- | --- |
| Implemented local code | The current local code includes reviewed operations, local approval, Chrome connections for Canvas and Moodle, controlled batches, source-linked review, and provider-specific scopes. Installed-client and live-provider results are recorded separately. |
| Full static gate | The final canonical-URL source passed the relevant workspace and script test gates. |
| Selected live Canvas proof | A lesson correction, narrow New Quiz key correction, two module-link writes, three publication operations, and one Student View learner route reached verified evidence. A request based on an older page version failed before send and a later page check showed no effect. |
| Selected Codex route | The installed Codex CLI read the published New Quiz. In a separate interactive test, native tool approval prepared a page update; Morrow approval led to one change attempt that reached verified state. Native and independent later checks confirmed the exact change and unchanged protected fields. This is one selected route only. |
| Moodle scope | Course and structure reads; hidden Page, Assignment, and Quiz creation without questions; Page, Assignment instruction, and Quiz instruction edits; and setting or clearing Assignment due dates and Quiz open/close dates were saved and checked through the Chrome connection in a Moodle test course. Selected work also covered Page and section visibility and reading Multiple choice and Essay questions. Every reviewed approval can be used only once. Question authoring, random and other question types, and changes to activities with attached files are not supported yet. Other activity types, section cases, and broader settings still need checks. |
| Blackboard scope | Browser connection is not yet verified. Blackboard course work is unavailable. |
| Illustrative film | The local site and film show workflow and visual direction. They do not establish a live LMS result. |

## Current Canvas proof

The Canvas record now shows a connected evidence chain.

An educator-provided source exposed a planted lesson error and a wrong saved New Quiz answer key through two independent specialist requests and a separate checker. The source-review exchange used a manual MCP host adapter.

An approved lesson correction reached a verified saved-page check. One phrase changed while title, URL, publication state, front-page state, and editing roles stayed unchanged. A later proposal with outdated page content failed before send. The following page check showed the same body and update time.

The New Quiz correction then reached verified after one change attempt. The before-and-after item comparison showed that only question one's saved scoring value and update time changed; all other question fields stayed unchanged. Two module-link writes and three publication operations also reached verified state. The later module check contained both the lesson and quiz.

In Canvas Student View, the published lesson displayed the corrected text. Next Module Item launched the quiz. Begin showed all three questions. After correct selections were submitted, the assessment result showed 100%, three of three points, the correct ribosomes answer, and all three feedback messages. This proves one selected sandbox learner route.

A separate unpublished page creation reached automatic verification after one change attempt. An independent check confirmed its exact identity, content, and saved settings. The installed Codex interactive client then prepared a one-paragraph update on another sandbox page. Native tool approval prepared the request; Morrow showed its current and proposed content for separate approval. One change attempt reached verified state. Both the native client and a later independent check confirmed the exact append and unchanged protected fields.

## Verification limits

Automatic assistant sampling remains unproven beyond the manual adapter. Independent clean-machine reproduction remains open. Moodle test-course proof covers course reads; Page, Assignment, and Quiz creation without questions; editing Pages, Assignment instructions, and Quiz instructions; and setting or clearing Assignment due dates and Quiz open/close dates. Selected test-course work also covered Page and section visibility and reading Multiple choice and Essay questions. Question authoring, random and other question types, and changes to activities with attached files are not supported yet. Other activity types, section cases, and broader settings still need checks. Blackboard browser connection is not yet verified. The selected Canvas sandbox sequence does not establish a full Canvas catalog, every learner flow, learning effectiveness, or whole-release verification. Morrow has no public deployment or institutional-use claim.

## Role families this work fits

- AI and education product lead or technical product manager.
- Learning-platform integrations or LMS product manager.
- Agentic systems, workflow reliability, or applied AI product engineer.
- Forward-deployed, solutions, or implementation product roles for education technology.
- Product roles that connect educator workflow, platform APIs, safety controls, and evidence design.

These are role families, not a claim of eligibility for a specific opening.

## 90-second interview walkthrough

“I created Morrow because generated course content is not enough for instructional teams. A real course change has a destination, permissions, related assessments, and learner consequences. I spent months building a clear process around that work.

“Morrow turns an assistant request into a review that shows the course, current content, and proposed change. A person approves one reviewed change. Morrow sends it once, checks the LMS again, and reports confirmed, unconfirmed, or failed results.

“The key design decision was to make uncertainty visible. In one live Canvas sandbox sequence, we verified a lesson correction, a narrowly scoped quiz-key correction, module links, publication, and a Student View path through a three-question quiz to a three-point result with feedback. We also tested a request based on an older page version: it failed before send, and the next check proved the page had not changed. That safe failure is as important as the success cases.

“The work is platform-specific. Canvas has selected sandbox proof through a browser connector. Moodle uses the same Chrome connection and has selected test-course proof for course reads; Page, Assignment, and Quiz creation without questions; editing Pages, Assignment instructions, and Quiz instructions; and setting or clearing Assignment due dates and Quiz open/close dates. Selected test-course work also covered Page and section visibility and reading Multiple choice and Essay questions. Question authoring, random and other question types, and changes to activities with attached files are not supported yet. Other activity types, section cases, and broader settings still need checks. Blackboard browser connection is not yet verified. Morrow is working toward the same core features across all three platforms, without claiming current parity. The selected Codex route is not universal assistant proof. This is not whole-release verification. The value of the work is product judgment: I built a system that lets course teams review AI-assisted changes before Morrow calls them complete.”

## Evidence sources

- Morrow product overview: local architecture, assistant boundary, platform scope, and release status.
- Canvas proof record: recorded operation receipts and proof scope for the selected sandbox.
- Implementation review: target checks, revision guard, separate approval, checks without automatic repeat, controlled batches, and educator-review limits.
