# Canvas admission classes

Every Canvas write passes one admission contract before anything is sent:
`packages/canvas-api-catalog/src/operation-admission.ts`. The contract either admits the write or
holds it with one named reason. The MCP runtime (`packages/canvas-connector-mcp/src/runtime.ts`),
the service worker (`connector/extension/src/service-worker.js`), and the page executor
(`connector/extension/src/canvas-content.js`) all enforce the same decision, and the browser copy of
the contract is generated, never hand-edited (`scripts/sync-canvas-readback-plan.mjs`).

This document names the classes and records what each held class needs before any of it can be
admitted. It quotes no counts: `artifacts/canvas-api/canvas-admission-report.json` is the generated
source, and the capability baseline table in [PROVEN-WORKFLOW-REUSE.md](PROVEN-WORKFLOW-REUSE.md)
quotes it.

## The classes

| Class | Route shape | What the person is told |
| --- | --- | --- |
| Admitted, course path | `/courses/{course_id}` or `/courses/{id}` anywhere in the route | Nothing: the write is available, and normal approval, Edit scope, binding, and readback rules apply. |
| Admitted, proved section | `PUT` and `DELETE /v1/sections/{id}` | Nothing: the connector reads the section and proves the selected course owns it immediately before it sends the change. |
| Admitted, proved group | The create, update, and delete routes for a group's own discussion topics and pages under `/v1/groups/{group_id}` | Nothing: the connector reads the group, requires Canvas to name a course as its owner, and requires the selected course's own complete list of groups to name that group, immediately before it sends the change. |
| Admitted, proved course file or folder | `PUT` and `DELETE /v1/files/{id}`, and `POST /v1/folders/{folder_id}/folders` | Nothing: the connector reads the file or folder, requires Canvas to name a course as its owner, requires the selected course's own complete list of files or folders to name it, freezes the saved version, and only then sends the change. A move is proved for the one destination folder it names. |
| Admitted, proved course calendar | `POST /v1/calendar_events`, `PUT` and `DELETE /v1/calendar_events/{id}`, and `PUT /v1/appointment_groups/{id}` | Nothing for a new event: the request names the selected course's own calendar, and the event is read back from its own route afterwards. For an existing event or an appointment group, the connector reads the object first and requires Canvas to name that same calendar. A repeat rule, a duplicate count, a series choice and section-level times are refused before anything is sent, because each reaches events the readback cannot check. An appointment group that serves more than one course is refused outright with `multi_context_object_not_supported`: "This Canvas appointment group serves more than one course. Morrow changes one course at a time, so it changed nothing. Change it in Canvas, or use one that belongs to this course alone." |
| `account_authority_required` | Any route that names an account, the whole Canvas instance, an LTI registration, or a developer key | "This change affects a whole Canvas account, not one course. Morrow does not yet have an account permission, so it will not send it." |
| `learner_scope_requires_separate_authority` | A route that names one person's own record: submitted work and the originality reports attached to it, a quiz attempt, a what-if grade, an enrollment, an assignment override, who is in a group, a booked appointment slot, or the deletion of a sign-up sheet, which cancels every slot booked in it | "Morrow does not change a student's own record: their submitted work, a quiz attempt, a grade, an enrollment, who is in a group, or a booked time slot. Those need their own permission, so make that change in Canvas." |
| `multi_step_upload_requires_reviewed_transfer` | A `POST` to a course-scoped upload route that ends in `/files`: the course files pre-flight, the assignment submission pre-flight, the quiz submission pre-flight, and the submission comment pre-flight | "Adding a file to Canvas needs Morrow's reviewed file transfer, which checks the file and its saved bytes. Morrow will not start a partial upload." |
| `cross_course_object_requires_resolution` | A route that names a group, group set, file, folder, outcome, a new appointment group, or a section move, for which no course-ownership reading is declared yet | "Canvas can attach this group, file, folder, calendar item or outcome to any course, and Morrow cannot yet prove that this one belongs to the course you selected. Change it in Canvas, or ask for the same change from inside the course." |
| `provider_contract_incomplete` | A route that asks Canvas for a sign-in token, a session, or a one-time action, and leaves no field behind to read | "This asks Canvas for a sign-in token, a session or a one-time action, and Canvas keeps nothing afterwards that Morrow can read back to show you what happened. Morrow does not send a change it cannot check, so make this one in Canvas." |
| `self_scope_not_supported` | `/v1/users/self/bookmarks` and `/v1/users/self/course_nicknames` | "Morrow does not change your personal Canvas bookmarks or course nicknames. It only changes content inside a selected course." |
| `new_quiz_lifecycle_planner_required` | Raw New Quiz create and delete | "Creating or deleting a New Quiz needs a governed lifecycle planner that freezes the complete request and verifies the saved assignment. Morrow does not offer this raw change." |
| `course_scope_required` | Everything else: a route with no course in it that names no object a course can own: a personal preference, an Inbox conversation, a poll, a planner item, an ePortfolio, a media object, a person's own account record, or an LTI tool deployment | "Morrow only changes things that live inside the one course you selected, and this change is not attached to any course. Make it in Canvas yourself, or ask for the same change on a page, assignment, file or other item inside the course." |

`canvasOperationAdmission` reads these classes in order, from the most specific fact about the route
to the least: account authority, then a course-scoped upload pre-flight,
then New Quiz lifecycle holds,
then a personal bookmark or nickname, then one person's own record, then an object Canvas can attach
to any course, then a request with no readable effect, and last the plain absence of a course. The
order matters where two facts are true of one route: a group membership route names both a person's
record and a group, and the person's record is what the change actually touches. The upload class is
read before the course path admits a write, because the course in the route is not what is missing.
The same first step outside a course, on a section, folder, group, or person, keeps the hold it
already had: those routes lack proof of the course before they lack the rest of the upload.

The sentence for a held write is published in the tool capability
(`profiles["public-canvas"].reason` and `evidence.admission.reason`,
`packages/canvas-api-catalog/src/index.ts`) and shown beside the action in the extension Edit
permission list (`connector/extension/src/edit-policy.js`, `connector/extension/settings/settings.js`).

## Item Bank course targets

Every private Item Bank write carries a selected `course_id`, so
`canvasOperationAdmission` records a direct course target. The course id is an
authority control and is not inserted into the private API path. All nine writes
remain held. Bank creation lacks a recoverable create-and-course-associate
transaction. Existing-bank changes lack complete downstream reach. The quiz bank
draw lacks durable recovery after a browser worker or process interruption. The
incomplete fan-out reader is review context only and never supplies or expands
authority.

## The account authority class

`canvasAccountAuthorityRoute` in `packages/canvas-api-catalog/src/operation-admission.ts` decides the
class from the route alone:

- `/v1/accounts/...` and `/lti/accounts/...`, or any route with an `{account_id}` path parameter.
  This includes the account LTI registration routes (`.../lti_registrations/...` and `.../apps/...`),
  the account developer key routes, and `/v1/account_calendars/{account_id}`.
- `/v1/global/...`, the outcome group routes that belong to the whole Canvas instance.
- `/v1/developer_keys/...` and `/lti/developer_key/...`, the Canvas API credential routes.

These writes carry `authority.scopeClass: "account"` in their published capability, and so do the
reads on the same routes. Reads stay available: the class describes the authority a route needs, and
holding a read would remove information an instructor can already see in Canvas.

Two neighbouring route shapes are deliberately outside the class. The `/lti/...` routes that act as
an installed tool rather than a registration (`/lti/subscriptions`, `/lti/notice-handlers/...`,
`/lti/asset_processor_eulas/...`, `/lti/asset_processors/...`) name a tool deployment, and the user
merge route (`/v1/users/{id}/merge_into/accounts/{destination_account_id}/users/{destination_user_id}`)
names two people. Both stay held as `course_scope_required`, which is accurate for them: Morrow
cannot prove one course from either route.

The class is about authority, not about a word in a path. A course-scoped LTI write
(`/lti/courses/{course_id}/line_items`, `/v1/courses/{course_id}/lti_resource_links`) is an ordinary
admitted course write with `scopeClass: "course"`. The account rule is applied before the
course-path rule, so a route that names both an account and a course stays held. In the current
catalog only one route names both, and it is a read: `GET /v1/accounts/{account_id}/courses/{id}`.

`packages/canvas-api-catalog/test/catalog.test.ts` pins the whole class: its size, its route
families, the sentence, the scope class, and that it admits nothing.

## What this class needs before any of it is admitted

[MORROW-REMAINING-WORK.md](MORROW-REMAINING-WORK.md) keeps account and administrative workflows in
the full product scope: the course-only authority model holds them, it does not exclude them.
Admission needs all five of the following. A course binding satisfies none of them.

1. **Exact current account context.** A fresh reading of the account the change would affect, taken
   in the connected Canvas session immediately before the change is sent, and frozen into the
   command record: account id, account name, root account id, and the signed-in person's admin role
   on that account. The selected course cannot supply it. An account read that is stale, ambiguous,
   or names a different account refuses the change; it does not fall back to the course.
2. **Its own approval class.** Account changes are not course changes, so they cannot ride on a
   course Edit permission. They need a separate account permission that a person grants explicitly,
   with the account named in the grant, plus a destructive tier for the account routes that delete
   or deactivate. Granting one account action must not grant the rest.
3. **Affected subject and data policy.** Before approval, the plan must state who and what the change
   reaches: how many courses, terms, users, or enrollments are inside its blast radius, and whether
   any learner record is in it. An account route can change many courses at once
   (`PUT /v1/accounts/{account_id}/courses` is one call), so an unbounded or uncounted subject list
   refuses the change. The privacy boundary does not change: no learner names, email addresses,
   submissions, grades, or verifiers reach an assistant-bound result.
4. **One explicit dispatch.** One reviewed plan sends one request once. A post-dispatch exception
   stays outcome-unknown and is not retryable, and the account target stays reserved until a fresh
   reading resolves it. Nothing in an account workflow may replay a completed step.
5. **An operation-specific readback.** Each admitted account route needs its own named reader that
   proves the exact requested postcondition on the object that was written, plus its evaluator and a
   focused test. The generic planner is not enough here: some of these routes are asynchronous and
   answer with a `Progress` object (`PUT /v1/accounts/{account_id}/courses` is one), others answer
   with a new object, and reading the account itself proves nothing about the change. Until a route
   has that reader, `supportsReadback` stays false and the saved result stays unconfirmed.

Implement one bounded account workflow at a time, with its own document, and only after all five
parts exist for that workflow. Nothing above has been proved against a live Canvas account; it is a
contract for future work and is live-unverified.

## What the other held classes need before any of them is admitted

- **`cross_course_object_requires_resolution`.** A course-ownership reading for the object family,
  declared in `packages/canvas-api-catalog/src/semantic-target.ts` and proved in the connector before
  dispatch, exactly as the section, group content, and course file and folder routes already work: read the object in the bound tab immediately
  before the change, require the reading to name the selected course, freeze it into the command
  record, and refuse on a mismatch, a missing field, or a truncated read. A route also needs its own
  readback through the same reading. A route whose effect reaches a second course, such as a section
  cross-list or a file copy into another folder, needs proof for both objects and stays held until
  that exists.
- **`learner_scope_requires_separate_authority`.** Its own permission, granted separately from the
  course Edit permission, plus the affected-subject and privacy rules a learner record needs. A course
  binding does not carry it. Nothing in this class is planned for admission on the course permission.
- **`provider_contract_incomplete`.** A route stays held while Canvas leaves nothing behind to read.
  It can only be admitted if Canvas exposes a reading that names the effect, and Morrow can bind that
  reading to the change it sent.
- **`multi_step_upload_requires_reviewed_transfer`.** A Canvas upload is three requests: the
  catalogued route asks Canvas where to send the bytes, a second request stores them at the address
  Canvas named, and a third confirms the saved file. Morrow runs all three only in its reviewed
  course-file transfer (`packages/mcp-server/src/canvas-file-transfer.ts`,
  `connector/extension/src/canvas-file-transfer.js`), which freezes one workspace file of at most
  1 MiB, sends the reviewed bytes once, and compares the file Canvas saved, including its bytes.
  Admitting the first step alone would start an upload nothing finishes. A generic upload route
  becomes admissible only with those remaining steps, their reviewed dispatch, and a readback of the
  saved file; the two submission routes and the submission-comment route would also need the learner
  authority above, because the file lands on a student's own record.
- **`course_scope_required`.** A route with no course and no course-owned object has nothing for a
  course binding to prove. These become admissible only through a different authority class, not
  through the course permission.

Nothing above is proved against a live Canvas tenant; every part of it is a contract for future work
and is live-unverified.

## What a proved course file or folder still cannot show here

The file and folder readings follow Canvas's published shape: `GET /api/v1/files/{id}` and
`GET /api/v1/folders/{id}` have to answer with `context_type` of `Course` and a `context_id` equal to
the selected course, and that course's own complete listing has to name the object. A tenant whose
file reading leaves those two fields out proves no course here, so Morrow refuses the change instead
of sending it. Nothing above has run against a live Canvas tenant: the whole file and folder path is
proved only in the synthetic estate in `scripts/test/canvas-connector-browser.mjs`, and it is
live-unverified. Canvas usage rights, which a tenant can require before a file is visible, are not
part of these three routes and are untested here.

## Status

Nothing in the account authority class is admitted, and the hold-reason taxonomy admits nothing
either: it names the hold each write already carried. The upload pre-flight class is the one change
to the admitted set: four writes that a course path used to admit are now held, and nothing moved
the other way. The MCP
runtime refuses a held write with the sentence for its class, and so do the published tool capability
and the extension Edit permission list. The service worker and the page executor refuse the same writes with
their own short message.
