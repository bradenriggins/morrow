# Canvas admission classes

Every Canvas request passes one admission contract before anything is sent:
`packages/canvas-api-catalog/src/operation-admission.ts`. The contract gives each request an
authority, `course` or `site`, and either admits a write or holds it with one named reason. The MCP
runtime (`packages/mcp-server/src/runtime.ts`), the connector (`packages/canvas-connector-mcp/src/runtime.ts`),
the service worker (`connector/extension/src/service-worker.js`), and the page executor
(`connector/extension/src/canvas-content.js`) all enforce the same decision, and the browser copy of
the contract is generated, never hand-edited (`scripts/sync-canvas-readback-plan.mjs`).

This document names the classes. It quotes no counts: `artifacts/canvas-api/canvas-admission-report.json`
is the generated source, and the capability baseline table in
[PROVEN-WORKFLOW-REUSE.md](PROVEN-WORKFLOW-REUSE.md) quotes it.

## Two authorities

A **course request** acts inside the one course the connection was made from. Every layer compares
the course the request names with that course, or proves the course that owns the named object.

A **site request** acts on the connected Canvas site as the signed-in person. Canvas applies that
person's own roles to it, so it reaches exactly what they can change in Canvas themselves, and no
layer narrows it to the selected course. It still needs the verified connection: the same site
origin, the same signed-in person, and the same session generation. The page executor sends it only
to the bound tab's own origin. Its effect lock is keyed by the site and the object, or by the route
when it names no object. A result can name people from any course on the site, so the privacy
boundary gives tokens to the selected course's learners and removes every other person's identity.

## Course classes

| Class | Route shape | What the person is told |
| --- | --- | --- |
| Course path | `/courses/{course_id}` or `/courses/{id}` anywhere in the route, including course learner records | Nothing: normal approval, Edit scope, binding, and readback rules apply. Learner identifiers resolve from Morrow's learner tokens. Deleting a course discussion topic is a destructive action whose readback proves the topic is gone. |
| Proved section | `PUT` and `DELETE /v1/sections/{id}` | Nothing: the connector reads the section and proves the selected course owns it immediately before it sends the change. |
| Proved group | The create and update routes for a group's own discussion topics, and the create, update, and delete routes for pages under `/v1/groups/{group_id}` | Nothing: the connector reads the group, requires Canvas to name a course as its owner, and requires the selected course's own complete list of groups to name that group. |
| Proved course file or folder | `PUT` and `DELETE /v1/files/{id}`, and `POST /v1/folders/{folder_id}/folders` | Nothing: the connector reads the file or folder, requires the selected course to own and list it, freezes the saved version, and only then sends the change. A move is proved for the one destination folder it names. |
| Proved course calendar | `POST /v1/calendar_events`, `PUT` and `DELETE /v1/calendar_events/{id}`, and `PUT /v1/appointment_groups/{id}` | Nothing for a new event on the selected course's calendar. For an existing event or an appointment group, the connector reads it first and requires that same calendar. A repeat rule, a duplicate count, a series choice and section-level times are refused before anything is sent. An appointment group that serves more than one course is refused with `multi_context_object_not_supported`. |

These carry `authority.scopeClass: "course"`, or `"course-object"` for the proved object routes.

## Site classes

Each site request carries one class. The Edit permission list shows its sentence beside the action
before it is granted (`canvasSiteAuthorityNote`), and groups the action under `Canvas site · <resource>`,
or under `Canvas actions that remove content` when it removes something. Site requests carry
`authority.scopeClass: "site"`.

| Class | Route shape | Sentence shown before it is granted |
| --- | --- | --- |
| `account` | Any route that names an account, the whole Canvas instance, an LTI registration, or a developer key (`canvasAccountAuthorityRoute`) | "It changes a Canvas account, not one course. Canvas decides it with your own account roles on this Canvas site." |
| `learner_record` | A person's record reached without its course: section submissions and grades, quiz submission questions, group memberships and invitations, a group's topic deletion, what-if grades, and appointment bookings and their cancellation | "It changes a person's record through a section, group, quiz attempt or booking rather than through the selected course, so it can reach a course other than the selected one. Canvas decides it with your own roles." |
| `multi_course` | A course-path route whose request or effect can name another course or account: Blueprint pushes, course copies and migrations, outcome imports and links, outcome-group deletion, course reset, and the broad course update | "It can read from or change a Canvas course or account besides the selected one. Canvas decides it with your own roles in each of them." |
| `shared_object` | A group, group set, file, folder, outcome, new appointment group, or section cross-list with no declared course reading | "Canvas can attach this group, file, folder, calendar item, section or outcome to any course, so the change is not limited to the selected course. Canvas decides it with your own roles." |
| `session_credential` | A request for a sign-in token, a session, or a one-time action that leaves no field behind to read | "It asks Canvas for a sign-in token, a session or a one-time action. Morrow keeps any credential Canvas returns out of the result, and Canvas keeps no record Morrow can read back." |
| `person` | Everything else with no course: bookmarks and course nicknames, Inbox conversations, polls, planner items, ePortfolios, media objects, preferences, and a person's own account record | "It changes something that belongs to you or another person on this Canvas site, not content in the selected course. Canvas decides it with your own roles." |

The raw Inbox routes are ordinary site requests. Morrow's private Inbox action stays available beside
them for a message sent from learner labels, and nothing moves a request from one to the other.

`canvasOperationAdmission` reads the site classes in order, from the most specific fact about the
route to the least: account, then a person's record reached without its course, then a multi-course
effect, then a course path or proved object (a course request), then a personal bookmark or
nickname, then an object Canvas can attach to any course, then a request with no readable effect,
and last everything else.

## Held writes

| Reason | Route shape | What the person is told |
| --- | --- | --- |
| `lti_authorization_required` | Any route on Canvas's LTI service under `/lti/`, including its account and developer key routes: line items, scores, originality and asset reports, EULA records, webhook subscriptions, notice handlers, and the public JWK update | "Canvas accepts this LTI service only with the LTI tool's own authorization, which your signed-in Canvas session does not hold. Make this change from the LTI tool." |
| `multi_step_upload_requires_reviewed_transfer` | Every upload first step, for a course, a folder, a group, an assignment, section or quiz submission, a submission comment, or a person, and both Rubric CSV imports. The raw route cannot carry the file's bytes; each of these targets is available through Morrow's reviewed file transfer | "Canvas takes a file's bytes in a later request that this route cannot carry, so Morrow sends every file through its reviewed file transfer, which checks the saved file and its bytes. Ask Morrow to prepare the file upload for this same target." |

Morrow's reviewed file transfer (`morrow_plan_canvas_file_upload`, `packages/mcp-server/src/canvas-file-transfer.ts`,
`connector/extension/src/canvas-file-transfer.js`) carries every upload route in
`CANVAS_REVIEWED_UPLOAD_ROUTES`. It freezes one workspace file of at most 1 MiB and one target route
with the exact ids its path needs, sends the upload first step with the page's request token, sends the
reviewed bytes once, reads the saved file back by its own id and compares its bytes. A folder upload
proves the name is free first; any other target accepts the copy Canvas renamed. A rubric CSV import
is posted to Canvas once and verifies only when Canvas reports the import finished without errors. A
course the route names must be the connection's course; every other target is a site request.

The Assignment duplicate is a course request with a named readback: it waits for the copy to reach a
documented saved state and compares its `original_assignment_id` and course, and a request that asks
Canvas to answer with a quiz is refused before it is sent.

The upload hold runs before the course path, because the course in the route is not what is missing.
The sentence for a held write is published in the tool capability (`profiles["public-canvas"].reason`
and `evidence.admission.reason`, `packages/canvas-api-catalog/src/index.ts`).

An admitted write is callable only when its readback is structurally exact. An admitted write
without one is profile-limited before provider I/O; the readback gaps are listed in
[PROVEN-WORKFLOW-REUSE.md](PROVEN-WORKFLOW-REUSE.md).

## Item Bank course targets

Every private Item Bank write carries a selected `course_id`, so `canvasOperationAdmission` records a
direct course target and admits it as a course request. The course id is an authority control and
is not inserted into the private API path. Each change is reread inside the Item Banks frame. The
incomplete fan-out reader is review context only and never supplies or expands authority.

## New Quiz create and delete

`canvas_create_new_quiz` and `canvas_delete_new_quiz` are course-path routes, so
`canvasOperationAdmission` admits them the same way it admits every other
course-scoped write: the guided New Quiz create and delete tools
(`packages/mcp-server/src/new-quiz-lifecycle.ts`) depend on that admission to
plan and dispatch through the same effect-authority path every other admitted
write uses. Holding them at the `canvasOperationAdmission` layer would hold
the guided tools' own dispatch along with the raw route, the same reason
Item Bank writes above stay admitted rather than held.

Instead, `connector/extension/src/edit-policy.js` refuses to publish either
tool as a directly Edit-grantable action (`NEW_QUIZ_LIFECYCLE_TOOLS`), the
same layer and the same mechanism that keeps Item Bank writes and the general
New Quiz item update out of a standing Edit permission. A raw call still
needs the frozen complete quiz list, saved-payload digest, and, for a
deletion, Canvas's own confirmation of no submitted or graded student work
that `packages/canvas-connector-mcp/src/server.ts`'s `newQuizLifecycleWriteSchema`
requires and `connector/extension/src/canvas-content.js`'s
`checkNewQuizLifecycleSource` reverifies against a fresh read immediately
before dispatch, regardless of which caller supplied it.

## What a proved course file or folder still cannot show here

The file and folder readings follow Canvas's published shape: `GET /api/v1/files/{id}` and
`GET /api/v1/folders/{id}` have to answer with `context_type` of `Course` and a `context_id` equal to
the selected course, and that course's own complete listing has to name the object. A tenant whose
file reading leaves those two fields out proves no course here, so Morrow refuses the change instead
of sending it. Nothing above has run against a live Canvas tenant: the whole file and folder path is
proved only in the synthetic estate in `scripts/test/canvas-connector-browser.mjs`, and it is
live-unverified. Canvas usage rights, which a tenant can require before a file is visible, are not
part of these three routes and are untested here.

## What the held writes need

- **LTI services.** An LTI access token for a registered developer key, obtained through Canvas's
  client-credentials grant and presented only to the LTI service routes.

## Status

Site requests are proved in the synthetic gateway, connector, and Bridge suites. They are
live-unverified against a Canvas tenant. The MCP runtime refuses a held write with the sentence for
its class, and so do the published tool capability and the extension Edit permission list. The
service worker and the page executor refuse the same writes with their own short message.
