# Write hazards: what breaks silently in Canvas

Canvas honors a surprising number of writes that should have failed.
These are the highest-severity silent-breakage classes, ported from
production doctrine and rewritten against this package's operations.
Read this before the first write in a session touching any of the
surfaces below, not after. None of these raise an error you can catch
at dispatch time; each one needs an explicit check in the plan.

Each hazard names its admission treatment. The admission policy is
the dispatch authority; these hazards are why some rows stay held.

## 1. Blueprint sync silently overwrites local edits

A blueprint sync from a template course to its associated courses
overwrites locked content everywhere. Any local edit an educator made
to a restricted object in an associated course is silently reverted
the moment the sync completes.

Admission treatment: blueprint operations are never-dispatch in this
package, full stop. Before ANY write to course content, check
`restricted_by_master_course` on the object: if it is set, the body,
points, or dates are locked by the master course and this session
does not touch them. Do not confuse this field with `lock_info`
(which is date/module lock state). There is no workaround lane; a
blueprint lock is provider truth about who may edit.

## 2. Changing points_possible rescales already-entered scores

Changing an assignment's `points_possible` **rescales every score
already entered** for that assignment. The write succeeds, the
gradebook quietly re-maps every grade, and nobody gets an error.
Changing `due_at` on the same call does NOT move existing overrides
(a separate, smaller trap on the same write).

Admission treatment: before any points change, ask the educator
whether submissions already exist on the assignment and disclose the
rescale to them in plain language as part of the approval (you cannot
read submissions yourself: the admission gate refuses submission
reads as learner-data, `LearnerDataGated`, which is a refusal, not an
evidence-hold). The educator approves the
rescale explicitly, not just the number. The post-write readback compares
more than the points field: read the assignment back and confirm the
points landed, and name the rescale in the receipt.

## 3. Rubric criteria replacement rescales graded scores

Replacing a rubric's criteria rescales every score already entered
against that rubric, the same hazard as (2) on a different object.
Check whether the rubric is already attached to a graded assignment
before proposing the replacement, and disclose the rescale in the
approval like any points change.

Admission treatment: **NOT IMPLEMENTED** in this package (no rubric
write rows are admitted). The doctrine is ported so the hazard is not
re-discovered the day a rubric write is proposed.

## 4. The weighting-flag trap: a number alone does nothing

Some Canvas grading numbers are inert unless a separate boolean
switch is set:

- `apply_assignment_group_weights` is the master switch. Assignment
  groups can carry `group_weight` values summing to 100, but if this
  flag is off Canvas ignores them and grades purely by points. Always
  read the flag before trusting or building a weighted scheme.
- Late-policy deductions each have their own `*_enabled` boolean and
  numeric value. Setting the number without enabling the matching
  flag has no effect on grading. Same shape as the weighting trap,
  different surface.

Admission treatment: when the educator's request touches grading
weights or late policy, the plan must state the current flag values
(read first), and the verification readback must confirm the flag
AND the number persisted. A 200 with the number present and the flag
off is the silent failure.

## 5. Publish / conclude / delete cascades

The highest-blast-radius writes in Canvas:

- Publishing a **course** is not the same as publishing its
  **content**: a published course full of unpublished modules shows
  students an empty course. Read that back: the publish receipt is
  the publish state of the content, not the course event.
- Course conclude/delete are the most destructive operations in the
  surface. They are on evidence-hold and the admission policy refuses
  them on every tenant: no approval, frozen plan, or ceremony admits
  them today, precisely because the blast radius is the whole
  enrollment. They stay held until a disposable live battery proves
  the complete path.
- Module publish with item cascade makes every item in the module
  student-visible in one call. Present it as exactly that to the
  educator: "this makes N items visible to students," with the count
  from a fresh read, not as "publish the module."

Admission treatment: destructive rows are held or refused by the
policy. Deletes require the D-005 delete receipt (follow-up GET 404,
or index removal for classic quizzes), never the DELETE status alone.
Announcements and conversation messages are permanently excluded;
drafting is not sending, and sending needs the educator's explicit
word.

## 6. Preview is not execution

A 200 from a validation, preview, or dry-run surface proves the
payload shape, not the effect. In this package the equivalent trap
is narrower: the journal row and the provider readback are the only
proof of a write. A successful dispatch with no journal record
(session death after claim journals a claim plus a release record),
or a journal row without a matching provider readback, is not a
completed write. Report it as exactly what it is.

## What this file is not

This is the lookup for what breaks silently, not a shape reference.
For request shapes, error codes, and the gotcha table, read
`api-patterns-and-errors.md`. For the write-path verification table,
read `audit-checklist.md`. For what the catalog actually admits,
read `operations-runbook.md`.
