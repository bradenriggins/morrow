# What Counts as a Finished AI Course Change?

**Status:** Draft. Publish only after author review.

AI can produce course copy fast. That does not make a course change finished.

A finished AI course change has separate evidence for five things: the source, the proposed change, permission to make it, the result saved in the LMS, and the learner experience. These are different questions. One successful response cannot answer all five.

This is practical, not philosophical. A page can contain a correct sentence and still have the wrong title, access setting, or URL. A quiz can ask a sound question and save the wrong answer key. A provider can report success while the LMS record stays unchanged. The point is to make each claim testable.

## 1. Establish the source

Start with a source that the educator selected. Quote the exact statement that matters. Do not ask a model to prove its own rewrite.

In a bounded Canvas test, the source stated that ribosomes are responsible for protein synthesis. The saved lesson instead stated that ribosomes were the main site of ATP production. The distinction is not a style preference. The source identifies ribosomes with protein synthesis and mitochondria with ATP production. [OpenStax Biology 2e, 4.3 Eukaryotic Cells](https://openstax.org/books/biology-2e/pages/4-3-eukaryotic-cells)

Two independent review steps found the lesson error and a related saved quiz answer error. A final check retained both findings. The evidence exchange used a manual MCP host adapter. That is evidence for this bounded review method. It is not evidence that every native AI client will perform the same review.

The educator still decides whether the selected source is sufficient, current, and appropriate for the course. Agreement between models does not turn a short source excerpt into verified teaching quality.

## 2. Specify the change

The proposed edit must name the target, current text, replacement text, and scope. “Fix the biology page” is a request for interpretation. “Replace this sentence in this page” is a change that someone can review.

In the test, the proposed replacement was one exact phrase: change the inaccurate ribosome statement to “Ribosomes assemble proteins.” The review stated that no change had been sent at that stage. That separation matters. A proposal is not a course edit.

## 3. Record permission

Approval must apply to the saved proposal, not to a general intent expressed earlier in a chat. The reviewer needs to see what will change and what will be preserved before permission is used.

For a Canvas page, preservation includes more than body text. Canvas exposes a page’s URL, title, publication state, front-page state, editing roles, body, and update time. It also supports a direct page read and revision history. [Canvas Pages API](https://canvas.instructure.com/doc/api/pages.html)

This makes a useful approval question: “Approve this exact text replacement on this exact page while preserving these settings?” It is concrete enough for an instructional designer to assess. It also gives the system a condition to test before it sends anything.

## 4. Verify the saved result

After approval, read the LMS record again. Compare it with the frozen pre-change record. Do not rely on a success message from a connector or provider.

The completed page-correction test showed the intended phrase in the saved page. It also showed that the title, URL, published state, front-page state, and editing roles stayed the same. A direct before-and-after comparison confirmed that the page body differed by the intended phrase only. That is evidence for one page correction. It does not establish that every Canvas change is safe.

The counterexample is as important. A second, stale proposal requested a different replacement. Its dispatch failed before send. The later Canvas read showed that the body and update time were unchanged. The correct result was `failed`, not “completed with a warning.” The system did not create a false record of a change that did not occur.

## 5. Check the learner experience

The final question is about the learner. Can the learner reach the lesson, complete the assessment, and receive the intended experience?

This test is not finished on that point. The review found a wrong saved answer key in a New Quiz item, but the corrected key and learner launch have not yet been verified. Therefore the course workflow is not complete. A correct lesson page does not prove that the assessment or learner path is correct.

This limit should stay visible. The bounded review did not evaluate rubrics, item-bank draws, linked files, media, accessibility, or general student access. The Canvas record can also change between the pre-check and the readback. Each excluded area needs its own evidence.

## A practical completion check

Before calling an AI-assisted course change finished, ask five questions:

1. What selected source supports the change?
2. What exact LMS record and fields will change?
3. Who approved that saved proposal?
4. What fresh read proves the LMS saved the intended result and preserved the required settings?
5. What learner-path check proves the course still works for its audience?

If one answer is missing, name the work as planned, unconfirmed, failed, or partially verified. That is not a weakness in the workflow. It is an accurate account of what the evidence supports.

AI can be useful in course production. The standard should be clear: a course change is finished when the source, change, permission, saved result, and learner experience each have evidence.
