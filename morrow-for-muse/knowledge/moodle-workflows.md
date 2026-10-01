# Moodle teaching and course maintenance

Use [the Moodle skill](../moodle/SKILL.md) for commands and admission.
Use this procedure for teaching intent and checks. Match advice to the site's
Moodle version, course format, enabled plugins, and the educator's actual role.
Catalog presence does not prove native support or permission. A refused
operation needs an explanation or draft, not an arbitrary API or UI bypass.

## Resolve the course and the learner route

Pair the account once. Resolve course names, ID values, or links through
account discovery. Preserve the full Moodle site path. Duplicate names need
the course ID, term, category, or another observed distinction. Keep the
educator's requested course set; there is no course-count limit. Page until
discovery is complete and report courses whose titles cannot be projected.

Read the course, sections, and relevant activities before proposing changes.
Keep course IDs, course-module IDs, activity instance IDs, and context IDs
distinct. A section's display number is not its persistent ID. Re-read a
target after moving or restoring it; do not infer its ID from position.

Trace entry → section → resource or activity → required action → completion
and feedback. A teacher's ability to open an activity does not prove learner
access. Check course and section visibility, activity visibility, restrictions,
group conditions, dates, and required completion. Do not impersonate a learner,
change enrollments, or alter permissions merely to get a preview.

## Weekly sections and visual quality

Use a consistent, descriptive section name and a short orientation summary.
Explain the week's purpose, required sequence, estimated workload, and finish
condition. Preserve the course's format and existing section naming scheme.
Check whether a move changes references, completion dependencies, or the
learner's sequence before applying it.

Choose a Page for a focused reading experience, a Book for related chapters,
a Folder for a file set, and a URL for an external destination when the
educator's intent fits those objects. Do not replace an established activity
merely to achieve a visual effect. Read [visual design](course-visual-design.md)
and [accessibility](accessibility-and-compliance.md). Inspect saved rendering,
responsive media, long labels, file loading, and the next action. A saved HTML
string alone does not prove a usable page.

## Completion and restrictions

Keep activity completion, access restrictions, course completion, and grades
separate. Moodle activity completion can depend on viewing, a score, or a
learner marking the activity complete. Check course and site enablement when
completion settings are missing. Do not assume a missing control means the
helper session expired.

Access restrictions can depend on dates, grades, groups, or completion, and
can apply to a section as well as an activity. Preserve the existing condition
tree and visibility behavior. A request to change one date does not authorize
removing every condition. State which learners or groups the proposed rule
can affect using the supported privacy evidence; do not reveal raw identities.

Before changing completion conditions in an active course, inspect available
evidence and identify effects on existing progress. If the governed route
cannot prove that evidence, retain the setting and provide a draft or ask
for the material missing fact. Never claim completion or a passing grade
from visibility, a checked box, or a successful settings save alone.

## Assessment and gradebook maintenance

Read the assessment instructions, attempts, dates, feedback, grading method,
and accommodations that the supported route can provide. Preserve existing
attempts and overrides. Distinguish a question-bank object from its use in a
quiz; changing a shared question can affect more than the visible quiz.
Do not infer a safe change when attempt or historical learner proof is held.

For gradebook work, inspect the category tree, aggregation method, item maximum,
weight, empty-grade treatment, extra credit, and drop/keep rules. A missing
grade is not necessarily zero or a missing submission. Site settings may
force controls that a teacher cannot change. Explain the intended calculation
and its effect before changing a category or item. Use the canonical review
and fresh digest, and compare the saved settings afterward. Never turn partial
grade evidence into a consequential learner decision.

## Forums and communication

Separate creating a forum activity from posting a discussion or reply.
Read the forum type, subscription behavior, group mode, availability, and
the intended audience. Subscription settings affect notifications; posting
may contact learners. A request to draft a prompt does not authorize posting
it. Check the exact operation's admission and historical privacy requirements.
Some learner-bearing routes remain held even when the catalog lists them.
If refused, return an educator-ready draft and state that nothing was sent.
Do not reuse Canvas discussion commands or assumptions about notifications.

## Copy, import, backup, and restore

Confirm exact source and destination courses, the desired content, and whether
the destination already contains active learners or work. State any requested
user-data inclusion explicitly. Keep learner records, role assignments, and
unrelated destination content outside a content-only request.

Use only the governed operation and its declared schema. For asynchronous
work, inspect final progress and errors before reporting success. Compare
restored sections, activities, file links, dates, restrictions, completion,
gradebook settings, and external-tool dependencies. A completed job is not
proof of complete course quality. Do not delete a source or destination as
incidental cleanup. Retain each course's outcome in a resumable batch.

## Files and recovery

Use `bin/morrow moodle stage-file` and reviewed manifests for supported file
operations. Keep file bytes in private encrypted state. Preserve the requested
file name, order, and target. Verify saved bytes, not only a draft upload or
file-list entry. The current 1 MiB transfer bound and 1–8-file set bound are
per-operation constraints; neither limits the number of courses.

If a file exceeds the supported transfer bound, state that limit before
planning a write. Do not silently truncate, rename, compress, or split it.
Offer an educator-approved alternative appropriate to the content.

An uncertain upload, save, or provider readback needs native state inspection.
Preserve the profile, journal, vault, and paired account. Never replay a write
or use a new operation ID to evade an uncertain claim. Use
[provider-specific recovery](troubleshooting-playbook.md).

Primary references checked 2026-10-01:
- [Moodle restrict access](https://docs.moodle.org/502/en/Restrict_access)
- [Moodle activity completion](https://docs.moodle.org/502/en/Activity_completion)
- [Moodle grade categories](https://docs.moodle.org/502/en/Grade_categories)
- [Moodle forum settings](https://docs.moodle.org/502/en/Forum_settings)

These references describe Moodle 5.2. Use the corresponding site's version
before relying on specific controls. Morrow commands and limits come from
the shipped skill, canonical catalog, source boundary, and executor.
