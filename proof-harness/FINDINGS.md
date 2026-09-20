# Findings from the proof harness

What the run showed about Morrow, as distinct from what it showed about the harness. Each entry
names the evidence that produced it. A finding that the evidence later contradicted is corrected
here rather than left standing.

## 1. An unattended run collides with its own pending approvals

A cleanup pass that asks to remove many objects in a row is answered, for some of them, with
"Morrow prepared this change and is waiting for approval. Ask your assistant to check the existing
request." Morrow holds one pending request per target, so a loop that asks again before the first
request is settled is told about the first rather than given a second.

Nothing is lost and nothing is wrongly applied. The consequence is narrower than it first appears:
an automated run has to settle each request before asking again for the same object, and a sweep
that assumes one pass is enough will leave objects behind and report a clean course.

This was first written up as a five-hundred-operation backlog holding targets. That was wrong: the
journal held three open operations at the time, and rubric deletions were completing normally. The
corrected mechanism is the one above.

Evidence: ledger rows `cleanup:MORROWPROOF1789874351`, `cleanup:verified-against-canvas`,
`queue:closed-after-write-phase` (three open operations, not five hundred).

## 2. Morrow refuses to let an automated process certify what a person must see

`morrow_operation_close_unresolved` requires `observed_state` and `confirmed_by_person`. A change
Morrow could not confirm cannot be closed by the process that made it; a person has to say what
Canvas shows. The harness cancels only requests that were never sent, and leaves anything that may
have landed open and reported.

This is correct behaviour and is recorded because it is load-bearing: it is the reason an
automated proof run cannot quietly mark its own uncertain writes as settled.

Evidence: the refusal text from `morrow_operation_close_unresolved`; `proof-harness/clear-queue.mjs`.

## 3. A write proof renames real course content, and a title is not proof of ownership

The write phase proves an update against a record the course already holds, which is what the
sandbox exists for, and the record keeps the written title afterwards. The course's real
"0.1 Course Overview" page therefore carries the title `MORROWSWEEP1789693946 wiki_page_title`.

A cleanup that matches on the mark in a title would delete it. This harness nearly did. An object
is now only removable when its own identifier carries the mark, which happens only when Canvas
derived that identifier from a title this harness chose at creation. A marked title on an
identifier the harness never generated is reported for a person to rename back.

Two consequences worth stating: a run that alters real content should record the previous value so
it can be put back, and a title is never evidence of who made something.

Evidence: page `0-dot-1-course-overview-2-2-2`; ledger row `cleanup:verified-against-canvas`,
field `carriesAMarkedTitleButWasNotMadeHere`.

## 4. Canvas's rubric delete is published under a name that says nothing

`DELETE /v1/courses/{course_id}/rubrics/{id}` is registered as `canvas_delete_single`. The name
carries no noun, so an assistant choosing a tool by name cannot tell what it deletes. The harness's
own cleanup called `canvas_delete_rubric`, which does not exist, and silently removed nothing for a
whole pass. Every other delete in the same family is named for what it removes.

Evidence: catalog entry `canvas_delete_single`; the first `cleanup:verified-against-canvas` pass.

## 5. Two catalog schemas do not match what Canvas requires

`canvas_get_module_item_sequence` is refused as invalid input when given only `course_id`, because
Canvas needs asset arguments the catalog does not mark required. `canvas_get_single_rubric_courses`
declares a numeric id, and the sandbox holds a legacy rubric whose id is `_1659`, so that rubric
cannot be passed back to the route that reads it.

Evidence: ledger rows `canvas_get_module_item_sequence`, `canvas_get_single_rubric_courses`,
`canvas_get_single_rubric_accounts`.

## 6. Two objects this run made are still in the sandbox, and why

The goal is that a run leaves nothing behind. This one leaves two things, each for a different
reason, and neither is hidden.

A page this harness created was made the course front page by a write proof. Canvas refuses to
delete a front page, and the delete is answered `failed`. Removing it properly means deciding what
the course's front page should be instead, which is a person's decision about their course, not a
cleanup script's.

A rubric's removal plans normally and its approval page renders "Remove rubric?", but posting the
nonce from that page is answered `409 approval_action_refused`, "approval nonce is missing,
expired, or invalid", with a nonce and cookie fetched seconds earlier. The same code path approved
376 writes in this run, so this is not approval failing in general; it is this operation's approval
being refused, and it is open.

Evidence: ledger row `cleanup:verified-against-canvas`; the 409 body above.

## 7. Undo is refused for a change Morrow itself verified

`morrow_operation_undo` does not invent the inverse of a change: the caller states the correcting
tool and arguments, which is a sound design. But a page create that Morrow had just settled as
verified, given `canvas_delete_page_courses` and that page's own identifier as the correction, is
answered `operation_unavailable`: "Morrow could not create a correction for this request. Check the
saved request before trying again." Canvas still holds the page afterwards.

Reproduced twice, on a freshly created operation as well as on one made earlier in the run. A
person told to undo a change they just made would be told to check the saved request instead.

Evidence: ledger row `morrow_operation_undo`, field `problem`.

## 8. What the sandbox cannot prove

Eighty operations need a learner attempt that no one has made in the sandbox course: submissions,
quiz sessions, statistics, and regrades. They are classified `NEEDS-LEARNER-ATTEMPT` rather than
attempted, because a route that answers an empty list proves nothing about the route.

Evidence: `manifest.json` classification counts.
