# What Counts as a Finished AI Course Operation?

**Status:** Draft. Publish only after author review.

An AI-generated draft is one part of a course operation. The work continues through review, approval, and the saved learning experience.

A finished course operation has evidence for six separate facts: the source, the bound target, the proposed change, the approval, the result saved in the LMS, and the learner experience. A generated paragraph, provider response, or green automation log cannot establish all six.

## Bind the operation before you write

Course work has context. A change belongs to a current account, explicit course, provider, and named record. Those conditions need to travel with the request.

That protects against a quiet failure: a valid instruction acting on the wrong place because the session, course, tab, or target changed. A responsible system checks its connection and target conditions before dispatch. If the saved operation no longer matches the current context, it stops and requires a fresh review.

The Canvas Pages API exposes a page URL, title, body, publication state, front-page state, editing roles, update time, and revision history. These fields let a team prove more than a changed sentence. [Canvas Pages API](https://canvas.instructure.com/doc/api/pages.html)

## Make the change readable

The review should name the current value, proposed value, affected record, and conditions that must stay the same. “Fix the biology page” is a request for interpretation. “Replace this sentence in this page while preserving these fields” is a reviewable operation.

In a bounded Canvas test, the supplied source stated that ribosomes are responsible for protein synthesis. The saved lesson assigned ATP production to ribosomes. The source distinguishes ribosomes from mitochondria on this point. [OpenStax Biology 2e, 4.3 Eukaryotic Cells](https://openstax.org/books/biology-2e/pages/4-3-eukaryotic-cells)

Two independent review requests found that lesson conflict and a related wrong saved quiz answer key. A separate checker retained both findings. The exchange used a manual MCP host adapter, so it is evidence for that bounded review route. It does not establish native sampling behavior in every AI client.

The proposed lesson correction changed one sentence. Before send, the review made the old text, replacement text, and preserved conditions visible. A model can propose the change. An educator decides whether the source, scope, and learning consequence are sound.

## Approve a saved operation

Approval should refer to a frozen request. The reviewer needs to know which account and course are bound, which record is affected, what will change, and what the system will preserve.

This rule matters for a batch. A controlled batch exposes every target before approval, preserves a per-item result, and stops starting new work after uncertainty. A batch is a bounded set of individually accountable operations, not one broad permission slip.

One approval can then start the saved request. It should not give an AI agent a general ability to approve later work. That separation keeps the course team in control when the request is concrete and when the evidence is incomplete.

## Read the LMS again

The saved LMS record is the evidence that matters after approval.

In the Canvas test, an approved lesson correction reached verified fresh readback. The intended phrase changed. The page title, URL, publication state, front-page state, and editing roles remained unchanged. A complete before-and-after comparison showed that the page body differed by the intended phrase only.

This is meaningful but narrow. It supports one verified page correction. It does not prove a whole catalog, every content type, or the quality of every instructional decision.

The counterexample is equally important. A later proposal used a stale pre-change condition. It failed before send. The later Canvas read showed the same body and update time as before that proposal. The correct record was `failed before send`, not “completed with a warning.” The system did not create a false claim that a change occurred.

If delivery becomes ambiguous, the responsible next action is a frozen readback and a clear state, not an automatic replay that might duplicate a change.

## Keep provider scope specific

The operating model can travel across LMS providers. The proof cannot.

Canvas has the broadest current Morrow catalog and selected live evidence through a signed-in Chrome connection. Moodle has six current tools: five reads and one course-summary write. Blackboard also has six: five reads, including nested content discovery, and one supported document title/body update. Moodle and Blackboard use separate private API connections.

Those Moodle and Blackboard scopes have official API and test validation. They do not have live-tenant evidence. This boundary tells an evaluator what can be reviewed now and what still needs real-provider proof.

Provider-specific scope prevents one provider's evidence from becoming another provider's claim.

## Finish at the learner path

The final question is about the learner. Can the learner find the lesson, complete the assessment, and receive the intended experience?

The Canvas test is not finished on that point. The wrong saved New Quiz key still needs correction, and the module linkage, publication, and learner launch are pending a connector reload. The lesson correction is verified. The course workflow is still incomplete.

That is the standard worth keeping: source, bound target, readable change, approval, saved result, and learner experience each need evidence. AI can help course teams move faster through the work. A course operation is finished only when the record supports what the team says happened.
