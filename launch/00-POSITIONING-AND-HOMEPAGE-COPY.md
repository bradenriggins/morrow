# Morrow positioning and homepage copy

## Positioning decision

**Morrow is a course-operations layer for AI-assisted LMS work.**

It turns a course request into a visible operation: bind the account and course, show the exact before and after, obtain approval for that saved request, and read the LMS again. The record ends as verified, unconfirmed, or failed. It does not end at generated text or a provider success response.

This is the story that makes the engineering visible. Morrow has an operations layer for course context, authority, approval, dispatch, recovery, and evidence. Course builders see the instructional consequence of that work: they can explain what changed, what stayed the same, and what the LMS saved.

## Audience and promise

**Primary audience:** Instructional designers, course builders, learning-technology teams, and faculty developers who must make accountable course changes.

**Promise:** Bring a course operation to Morrow. Review its exact target and change. Approve it once. See the saved result or the uncertainty that remains.

**Category:** Reviewable course operations with AI.

**What makes Morrow distinct:** The AI can propose work. Morrow holds the operating conditions around that work: exact account and course binding, readable before-and-after content, a local approval decision, stale-change refusal, fresh readback, and controlled batches. The educator retains instructional judgment.

## Homepage copy

### Metadata

**Title:** Morrow — Course operations with a clear record

**Description:** Morrow is a local development preview for course teams who need to review an AI-assisted LMS change, approve the exact request, and inspect the saved result.

### Navigation

`How it works` · `Current evidence` · `Provider scope` · `Preview requirements`

### Hero

**Eyebrow:** Course operations development preview

**Headline:** Make the course change. Keep the record.

**Body:** Morrow turns an AI-assisted request into a course operation you can inspect: the bound account and course, the proposed change, one approval, and a fresh LMS result. When the system cannot establish the result, it says so.

**Primary CTA:** Review current evidence

**Secondary CTA:** Read preview requirements

**Status line:** Private evaluation only. Public deployment awaits approval.

### The problem

**A useful draft is not yet a course operation.**

Course work has a target, permissions, dependencies, and learner consequences. A page may be accurate while its related quiz key is wrong. A request may look successful while the LMS record remains unchanged. A batch may need to stop after one uncertain result. Morrow keeps those conditions visible.

### The course-operation sequence

**1. Bind the request.**

Morrow binds work to the current account, explicit course, provider capability, and target record. A stale connection, changed target, or mismatched operation does not become a silent write.

**2. Review what will change.**

The local review shows the current value, proposed value, affected target, and preserved conditions. Long-form content stays readable. Batches show their complete target set before approval.

**3. Approve the saved request.**

One local approval starts the frozen operation. The AI does not approve a course change.

**4. Read the provider again.**

Morrow checks the saved result against the frozen condition. A matching readback can be verified. An uncertain or failed result remains visible, and an ambiguous write is not automatically replayed.

### Current Canvas evidence

The current Canvas test establishes a narrow, real result. An educator-provided source exposed a planted lesson error and a wrong saved New Quiz answer key through two independent review requests and a separate checker. An approved lesson correction then reached verified readback: one phrase changed, while the page title, URL, publication state, front-page state, and editing roles remained unchanged.

A later stale proposal did not dispatch. The subsequent page read showed the body and update time were unchanged. This is evidence that a stale operation can fail before send without creating a false completion record.

The New Quiz key correction, module links, publication, and learner path remain pending a connector reload. The source-review exchange used a manual MCP host adapter. It is evidence for that bounded adapter path, not native AI-client sampling compatibility.

### Provider scope

| Provider | Current operation scope | Setup boundary | Evidence boundary |
| --- | --- | --- | --- |
| Canvas | Broad catalog. Current live evidence covers a selected lesson correction and stale-request refusal. | Signed-in Canvas session through the local Chrome connector. | Selected test-course evidence only. It does not establish the full catalog, quiz-key correction, or learner path. |
| Moodle | Six tools: five reads and one course-summary write. | Private, locally saved API connection. | Official API and test validation only. No live Moodle tenant evidence. |
| Blackboard | Six tools: five reads, including nested content discovery, and one supported document title/body update. | Private, locally saved API connection. | Official API and test validation only. No live Blackboard tenant evidence. |

The operation model is shared. Provider setup, available operations, and evidence remain specific to each provider.

### For instructional design work

**Keep the source connected to the operation.**

Morrow can compare selected Canvas lesson and New Quiz evidence with educator-provided source text. The review preserves source and target quotes, concrete proposed corrections, reviewer disagreement, and limits before any request changes Canvas.

**Review assessment structure without pretending to judge it.**

Morrow can inspect directly saved New Quiz question counts, points, answer settings, and repeated content. A structural check does not establish instructional quality.

**Control related work.**

Bounded batches retain an explicit target set, dependency conditions, per-child result, and stop behavior after uncertainty. They make larger work reviewable without converting it into one opaque request.

### Preview requirements

Morrow is a local development preview. Canvas uses a local Chrome connector and a signed-in test course. Moodle and Blackboard use separate private API connections and are not general-user setup paths. A private evaluator package, one selected AI-client path, clean-machine reproduction, and an approved contact route are required before any evaluator invitation.

### Closing

**Build the course. Keep the judgment. Keep the record.**

Morrow is for course teams that want AI assistance without losing the target, the decision, the saved result, or the limits of the evidence.

**Primary CTA:** Review current evidence

**Secondary CTA:** Read preview requirements

## CTA rules

| Stage | Primary CTA | Secondary CTA | Reason |
| --- | --- | --- | --- |
| Current private preparation | Review current evidence | Read preview requirements | Neither action implies public availability or a functioning acquisition route. |
| After evaluator package, proof, and contact approval | Request private evaluation | Read provider scope | The request path exists only for an approved audience. |
| After public deployment approval | Install Morrow | See supported provider workflows | Installation requires current provider, client, and clean-machine receipts. |

Do not use `Join the waitlist`, `Start free`, `Book a demo`, or `Install now` before their product and operational paths exist.

## Claim boundary

Use these claims now:

- Local course-operations development preview.
- Exact course and account binding, readable review, one local approval, stale-change refusal, fresh readback, and controlled batch behavior.
- Selected Canvas test evidence: a lesson correction reached verified readback; a stale proposal failed before send and left the saved page unchanged.
- Canvas has the broadest current catalog; live proof remains selected and bounded.
- Moodle and Blackboard have the stated API/test scopes, with private API setup and no live-tenant claim.

Do not use these claims now:

- Production readiness, institutional approval, customer adoption, performance results, or universal LMS support.
- Live Moodle or Blackboard operation proof.
- Completed New Quiz key correction, module linkage, publication, learner-path verification, or educational correctness.
- Native ChatGPT, Codex, Claude, or Gemini source-review compatibility.
- Public installation, hosted synchronization, or a general evaluation path.
