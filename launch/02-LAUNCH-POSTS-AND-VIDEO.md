# Morrow launch posts and video

## LinkedIn post 1 — Founder story

**Visual:** Five beats: source and target → readable approval → saved corrections → sandbox learner result → stale request refused. Mark it `Private development preview`.

I have spent months building Morrow around one question:

How do we know an AI-assisted course change is actually finished?

Course teams need more than a draft. They need the right course, the current content, a decision they can review, and a result they can check.

Morrow brings that work into one flow: request → review → approval → saved result.

A recent Canvas sandbox test made this concrete. A source review found a wrong lesson statement and a wrong quiz key. Morrow read Canvas again and confirmed that one lesson phrase changed while the page settings stayed the same. The quiz-key readback showed that only the intended scoring value and update time changed.

The published lesson then led through `Next Module Item` to the three-question quiz in Canvas Student View. The submitted sandbox result showed 100%, three of three points, the correct ribosomes answer, and all three feedback messages.

Then a second request used the old page state. Morrow stopped it before sending. The saved page remained unchanged.

Those details have shaped months of engineering: exact course and account binding, readable changes, controlled batches, fresh readback, and clear outcomes when something cannot be confirmed.

The wider goal is a useful operations layer for course teams across learning platforms. Canvas has selected sandbox evidence. The current Moodle and Blackboard adapters have official API and test validation, with no live-tenant claim. This selected learner route does not verify a full release, every Canvas operation, or learning effectiveness.

I am preparing Morrow for private evaluation, with the workflow and its evidence available for review.

## LinkedIn post 2 — Product proof

**Visual:** A 35-second proof clip. Use the five beats below. Keep the status strip visible in every frame: `Selected Canvas sandbox evidence · manual source-review adapter · learner route verified`.

Here is the proof standard I want for AI-assisted course work.

Start with the source and the exact course target. Show the conflicting lesson text. Show the proposed replacement before anything is sent.

Then show the decision: one saved request, reviewed by a person.

Then show the saved results. In the current Canvas test, the approved lesson correction reached fresh readback. One phrase changed. The page title, URL, publication state, front-page state, and editing roles remained the same. The New Quiz comparison showed one scoring value and its update time changed; all other question fields stayed the same.

Then show the learner sequence: published lesson, `Next Module Item`, three quiz questions, and the submitted sandbox result with three of three points and all feedback visible.

Then show the counterexample. A later stale proposal failed before send. The next read showed no page-body or update-time change.

That is the operating model: request → review → approval → saved result. It also has a truthful failure state.

The source review in this clip uses a manual MCP host adapter. It is not native AI-client sampling proof. This is one selected sandbox route, not a claim about a full Canvas catalog, every learner flow, or learning effectiveness.

Morrow is a private development preview. The public preview will follow only after the current proof and delivery gates close.

## LinkedIn post 3 — Practical lesson

**Visual:** A five-part evidence chain: source → bound target → reviewed change → saved result → learner experience. Use a sixth, smaller branch from review: `stale? stop and re-read`.

When AI helps with a course, ask five questions before you call the work finished:

1. What source supports the change?
2. Which account, course, and record will change?
3. What does the reviewer approve exactly?
4. What fresh LMS read proves the intended result and preserved settings?
5. What learner-path check proves the work is usable?

This method applies across learning platforms. The provider changes the setup and available operation. The evidence standard stays the same.

For Canvas, Morrow uses a signed-in Chrome connection. Moodle and Blackboard use separate private API connections. Each provider needs its own scope and its own proof.

The practical rule is simple: do not turn a generated draft into a completed course change until the evidence chain is complete.

Morrow is the development preview I am building around that rule. The framework is useful with or without Morrow.

## 60-second proof video script

**0–12 seconds — Source and target**

On-screen: Sanitized account, course, provider, and page labels lock into one operation card. A source quote sits beside the conflicting lesson sentence. No IDs, learner names, or secrets.

Voice: “An AI draft is not yet a course operation. Morrow binds the source, account, course, provider, and exact target.”

Lower third: `Selected Canvas sandbox evidence · source review uses a manual MCP host adapter`

**12–22 seconds — Readable approval**

On-screen: Local review with the exact before/after and preserved page fields. A person selects one approval control.

Voice: “The review makes the source and change readable. A person approves one saved request.”

**22–34 seconds — Saved corrections**

On-screen: Fresh Canvas lesson readback highlights the corrected phrase and the preserved title, URL, publication state, front-page state, and editing roles. Cut to the New Quiz diff: `scoring value changed` and `all other fields unchanged`.

Voice: “Fresh readback confirmed the lesson correction. The quiz check confirmed one intended scoring value changed while the other question fields stayed the same.”

**34–47 seconds — Learner result**

On-screen: Published lesson → `Next Module Item` → three quiz questions → sanitized result panel: `3/3 · feedback shown`. Do not show the learner name.

Voice: “In Canvas Student View, the corrected lesson led to the quiz. All three questions appeared. The submitted sandbox result showed three of three points and all feedback.”

**47–60 seconds — Safe refusal and scope**

On-screen: A separate request receives `stale change` then `failed before send`. Cut to the unchanged page body and update time. End with `Selected Canvas sandbox evidence · Moodle and Blackboard: API/test scope`.

Voice: “A later stale request did not send, and the next read showed no page change. Morrow keeps evidence specific to each provider and each operation.”

End card: `Morrow · Private development preview`

## 20-second proof teaser

**0–04 seconds**

On-screen: `A draft is not yet a course operation.`

Voice: “A course change needs more than generated text.”

**04–08 seconds**

On-screen: Source quote → bound course target → exact before/after.

Voice: “Bind the work. Review the exact change.”

**08–13 seconds**

On-screen: One approval, then fresh lesson and quiz readbacks with `verified`.

Voice: “Approve one saved request. Then read the LMS again.”

**13–17 seconds**

On-screen: Published lesson → quiz → `3/3 · feedback shown`.

Voice: “Then follow the selected sandbox learner route.”

**17–20 seconds**

On-screen: `stale change` → `failed before send` → `page unchanged`.

Voice: “If the request is stale, stop it before send.”

## Production rules

- Use only current test-course recordings and statuses established by a receipt.
- Show the verified lesson correction, narrow quiz-key correction, module links, publication, and Student View route as one selected sandbox sequence.
- Mark the source review as manual-adapter evidence.
- State that the selected sandbox sequence does not establish a full Canvas catalog, every learner flow, whole-release verification, or learning effectiveness.
- Do not show learner names, grades, identifiers, tokens, secrets, or raw technical logs.
- Do not imply live Moodle or Blackboard tenant proof, native AI-client sampling, automatic educational correction, or public availability.
