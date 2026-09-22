# Meridian course-work principles for Morrow

Historical source (not shipped in this package): `origin-morrow/docs/research/MERIDIAN-KNOWLEDGE-FOR-MORROW-2026-09-06.md`
(documentation read through SSH on the Meridian host, 2026-09-06;
read-only, no provider calls). These are the course-work principles
ported from Meridian's team doctrine and proven in daily production
use ON MERIDIAN. They are agent-behavior doctrine for Morrow for
Muse, not proven v1 behavior here: the "Ported to" line under each
principle names where, if anywhere, this package encodes it. Where a
principle has no mechanism yet, it is documented here only and must
not be claimed as product behavior.

## The default: preserve, don't redesign

Ported to: agent behavior only (this file). The a11y repair
manifests under `catalog/a11y/` (source tree only; not shipped in the
distribution) encode the same discipline for
repairs (one selected fix at a time, all other item state
preserved, judged against the current state Canvas holds).

- Preserve course-local design by default. Read the exact target and
  relevant examples first. Make the smallest suitable change. Keep
  unrelated HTML, media, links, assessment intent, and native Canvas
  settings untouched.
- A redesign needs a clear request from the educator. Apply the rule
  separately to every course in a batch: what was asked for in course
  A does not authorize the same change in course B.
- Identify course patterns and separate observed evidence from
  inference. Partial reads must be reported as samples, never as
  complete surveys.

## The learner route

Ported to: agent behavior only (this file). No mechanism in this
package walks the learner's route end to end.

Course review must check the learner's route: where the item sits,
what the destination is called, which source references it, what
action steps it takes, and what the submission instructions say.
Review a course the way a student walks it, not the way the API
lists it.

A course connection does not prove publisher entitlement or a
working learner launch. Saying "it's connected" is not saying "it
works for students."

## What knowledge discovery grants (and doesn't)

Ported to: `knowledge/audit-checklist.md` (the recipe discipline:
proven names do not pair with arbitrary arguments; readback from
fresh provider reads after every write) and
`knowledge/write-hazards.md` (uncertain writes must not be repeated
automatically; file verification against saved bytes).

- Catalog discovery describes capability. It does not grant consent.
  Being able to list something is not permission to change it.
- Concurrent callers use current preconditions and a single recorded
  effect. Uncertain writes must not be repeated automatically.
- File verification must eventually compare saved bytes. A filename
  or a success response cannot prove file content.
- Visual work needs saved-state readback and rendered inspection.
  Limited automated accessibility signals do not establish
  conformance.
- Identity, site, course, target, and current-source evidence bind
  each action. Verify the dispatch target on every action: the course,
  object, and identity in hand must be the ones the educator asked
  for. Nothing is gated by tenant (parity law), so this is
  per-dispatch verification discipline, not a claim that proof on one
  course transfers to another: check the target, not the pedigree.

## Accessibility repair (course-level)

Ported to: the Morrow plan manifests under `catalog/a11y/` (repair
manifests for course pages, assignments, discussions, classic quiz
descriptions, classic quiz questions, and New Quiz items; source
tree only, not shipped in the distribution), which
encode this discipline: repair one selected missing `alt` at a time,
preserve all other item state, judge an edit against the current
state Canvas holds (refuse only for a media problem the change would
add), and verify with saved-state readback. Repairing one image is
never refused because a different image still needs work; adding a
second copy of an undescribed image is still refused.

These manifests are plan artifacts, not live-proven v1 operations:
they describe a repair workflow, they do not authorize dispatching
one. Dispatch only through the governed executor with the educator's
approval.

## What is NOT ported

Meridian's daemon layout, descriptor issuer, tool names, production
paths, and publisher adapters are specific to Meridian and were not
copied. Connect and MindTap integrations are not cleared for
inclusion. What came over is the doctrine above, not the machinery.
