# LMS administration and program operations

Administrative knowledge does not grant administrative authority. Bind each
task to the actual account, role, site, term, course set, and supported operation.
Use least privilege. Do not modify roles, enrollments, institutional defaults,
SSO, integrations, or account-wide settings as an incidental course repair.

## Establish context

Identify institution, account/subaccount or Moodle category, term/cohort,
course IDs, ownership, templates, and intended audience. Distinguish a sandbox,
concluded course, live delivery course, and template. Similar names are not
identity evidence. SIS-managed records can be overwritten by a later sync;
read the institution's ownership and change process before suggesting edits.

## Canvas administration

Blueprint associations and locked content can limit local edits or cause later
syncs to replace them. Distinguish Blueprint management, course permissions,
and assignment permissions. Do not assume a course teacher can change the
account, integration, role, or locked template. Cross-listing changes section
context and can affect learner work; imports, enrollments, and publication can
have wider effects than a page edit. These are concepts, not a promise that
Morrow admits these operations. Consult the shipped policy and catalog first.

## Moodle administration

Capabilities can be granted or overridden at different contexts. Plugins and
site policies affect AJAX functions, file handling, gradebook, completion,
backup, and restore. Verify the deployed version and site-level capability
probe. An unavailable AJAX function is not permission to guess another endpoint.
The packaged production-session and write-governance limits remain binding.

## Program-wide review

Define one rubric: structure, naming, outcomes, assessment alignment, dates,
learner route, accessibility, publication, and external dependencies. Discover
the full course set, continue partial pagination, and record each target's
coverage. There is no course-count limit. Use bounded batches with resumable
results and provider rate-limit backoff; do not treat all courses as one mutable
transaction. Verify each target and avoid copying stale object IDs across them.

Separate program standards from course-local choices. A style change requested
for one course does not authorize program-wide redesign. An explicit program
request can authorize the whole identified set without repeated course picking.
Show material exceptions and stop only affected targets when possible.

## Change management and incident response

Read current state, identify dependencies and side effects, document the
rollback or its absence, and use the admitted governed route. Verify the saved
state, downstream links, and provider job status. Do not declare an import or
backup complete from its initial acceptance response. Keep an audit trail that
contains scope, object IDs, results, and verification without credentials or
learner records. An unknown write outcome requires readback before any retry.

For outages distinguish site reachability, egress, helper, account session,
permission, operation support, and payload errors. Preserve profiles and logs.
Escalate institution-wide changes through the institution's owner; do not
silently grant yourself privileges or change a security setting to restore work.
