# Blackboard Learn REST scope

Written 7 September 2026 against this checkout.

Morrow reaches Blackboard through the official Anthology Learn REST API.
`packages/blackboard-learn-api` runs as an internal stdio child of the Morrow
Gateway under the source id `blackboard-rest`, in the `private-full` profile
only, and only when the local Blackboard setup file exists. No browser takes
part in that route.

**No live Blackboard tenant has been tested.** Every statement here is proved
against the operation registry in that package, the generated catalog in
[`artifacts/blackboard/blackboard-rest-catalog.json`](../../artifacts/blackboard/blackboard-rest-catalog.json),
and local mocked-HTTPS tests. None of it is evidence about a Learn site, and
every Blackboard result carries the evidence label
`api_configured_live_untested` for that reason.

This document is the route inventory, the entitlement record, the held-operation
list, and the live-tenant acceptance runbook.
[LIMITATIONS.md](../../LIMITATIONS.md) holds the user-facing limits,
[ARCHITECTURE.md](../../ARCHITECTURE.md) describes the boundary, and
[blackboard-recovery-contract.md](../research/blackboard-recovery-contract.md)
holds the browser contract, which is not implemented.

## What has to exist before Morrow can call Blackboard

1. **An administrator-installed REST application.** A Blackboard administrator
   registers Morrow's REST application on the Anthology developer portal and
   installs it on the Learn site against its Application ID and a named Learn
   user. Anthology states that the integration acts as that Learn user, and that
   with End User Access set to No it always does, whichever person asked for the
   change. Morrow cannot see which user the administrator chose, so it checks the
   account itself (below). The administrator also maps the endpoint entitlements
   the routes below need to that user's system role.
   Sources: [REST and Learn](https://docs.blackboard.com/docs/blackboard/rest-apis/getting-started/rest-and-learn),
   [entitlements](https://docs.blackboard.com/docs/blackboard/rest-apis/getting-started/getting-started-with-entitlements).
2. **Local credentials.** The person setting Morrow up supplies the site's HTTPS
   origin, the application key and the application secret. The app verifies
   the integration account through `users/me` and lists its real courses before
   saving the selected bindings. Morrow writes `~/.morrow/blackboard-learn.json` and the secret to
   `~/.morrow/credentials/blackboard/<tenant id>.secret`, both as private files
   it reads back by digest. `MORROW_BLACKBOARD_CONFIG` moves the setup file, and
   `MORROW_BLACKBOARD_SECRET_<TENANT_ID>` supplies the secret in place of the
   credential file. The secret never reaches the assistant, the client
   configuration, or any result.
3. **One course binding.** Morrow derives each binding id from the exact origin,
   integration account, and course id; it is never typed and never supplied by a
   caller. Without a binding every course route refuses with
   `blackboard_scope_binding_required`.
4. **A site token.** Morrow requests one OAuth2 client-credentials token from
   `POST /learn/api/public/v1/oauth2/token` with HTTP Basic `key:secret`.
   Anthology documents that this token belongs to the Learn site rather than to a
   person, and that it expires after one hour.
   Source: [Basic authentication](https://docs.blackboard.com/docs/blackboard/rest-apis/getting-started/basic-authentication).
5. **A confirmed account.** Before any course read, Morrow reads
   `GET /learn/api/public/v1/users/me` and requires the id to equal the
   configured integration account. A site that does not answer that route leaves
   the account unproved: reads then need the tenant to be configured
   `principalVerification: "membership-only"`, and every change is refused.

## Route inventory

69 tools: 55 reads and 14 writes;
43 are private source tools and 28
of those are registered only for the Gateway process that starts this server.
The table is generated from the same registry as the catalog artifact, and
`scripts/test/blackboard-doc-consistency.test.mjs` fails when the two disagree.

| Tool | Module | Learn route | Access | Reachable from | Entitlement | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `morrow_blackboard_health` | health | None. Sends no Blackboard request. | read | Full surface, or `morrow_capability_read` | `none` | `api_configured_live_untested` |
| `blackboard_read_course` | course-read | `GET /learn/api/public/v1/courses/{course_id}` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_list_course_contents` | course-read | `GET /learn/api/public/v1/courses/{course_id}/contents?recursive=false` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_read_course_content` | course-read | `GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_list_my_courses` | course-contents | `GET /learn/api/public/v1/users/{principal_id}/courses` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_list_content_children` | course-contents | `GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}/children?recursive=false` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_get_course_availability` | course-contents | `GET /learn/api/public/v3/courses/{course_id}?fields=id,courseId,name,ultraStatus,closedComplete,availability` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_inventory_course_contents` | course-contents | `GET /learn/api/public/v1/courses/{course_id}/contents?recursive=false` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_course_roster_summary` | memberships | `GET /learn/api/public/v1/courses/{course_id}/users` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_read_course_membership` | memberships | `GET /learn/api/public/v1/courses/{course_id}/users/{user_id}` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_read_integration_account` | memberships | `GET /learn/api/public/v1/users/{principal_id}` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_plan_membership_patch` | memberships | `GET /learn/api/public/v1/courses/{course_id}/users/{user_id}` | read | Private source tool | `unknown` | `api_configured_live_untested` |
| `blackboard_apply_reviewed_membership_patch` | memberships | `PATCH /learn/api/public/v1/courses/{course_id}/users/{user_id}` | write | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_verify_membership_patch` | memberships | `GET /learn/api/public/v1/courses/{course_id}/users/{user_id}` | read | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_list_gradebook_columns` | gradebook | `GET /learn/api/public/v2/courses/{course_id}/gradebook/columns` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_read_gradebook_column` | gradebook | `GET /learn/api/public/v2/courses/{course_id}/gradebook/columns/{column_id}` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_list_gradebook_attempts` | gradebook | `GET /learn/api/public/v2/courses/{course_id}/gradebook/columns/{column_id}/attempts` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_read_gradebook_attempt` | gradebook | `GET /learn/api/public/v2/courses/{course_id}/gradebook/columns/{column_id}/attempts/{attempt_id}` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_read_gradebook_grade` | gradebook | `GET /learn/api/public/v2/courses/{course_id}/gradebook/columns/{column_id}/users/{user_id}` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_plan_gradebook_column_patch` | gradebook | `GET /learn/api/public/v2/courses/{course_id}/gradebook/columns/{column_id}` | read | Private source tool | `unknown` | `api_configured_live_untested` |
| `blackboard_apply_reviewed_gradebook_column_patch` | gradebook | `PATCH /learn/api/public/v2/courses/{course_id}/gradebook/columns/{column_id}` | write | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_verify_gradebook_column_patch` | gradebook | `GET /learn/api/public/v2/courses/{course_id}/gradebook/columns/{column_id}` | read | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_plan_gradebook_grade_patch` | gradebook | `GET /learn/api/public/v2/courses/{course_id}/gradebook/columns/{column_id}/users/{user_id}` | read | Private source tool | `unknown` | `api_configured_live_untested` |
| `blackboard_apply_reviewed_gradebook_grade_patch` | gradebook | `PATCH /learn/api/public/v2/courses/{course_id}/gradebook/columns/{column_id}/users/{user_id}` | write | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_verify_gradebook_grade_patch` | gradebook | `GET /learn/api/public/v2/courses/{course_id}/gradebook/columns/{column_id}/users/{user_id}` | read | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_list_content_attachments` | files | `GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}/attachments` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_read_content_attachment` | files | `GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}/attachments/{attachment_id}` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_plan_content_attachment` | files | `GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}/attachments` | read | Private source tool | `unknown` | `api_configured_live_untested` |
| `blackboard_apply_reviewed_content_attachment` | files | `POST /learn/api/public/v1/courses/{course_id}/contents/{content_id}/attachments` | write | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_verify_content_attachment` | files | `GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}/attachments` | read | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_read_course_assessment` | assignments | `GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_plan_ultra_assignment` | assignments | `GET /learn/api/public/v3/courses/{course_id}?fields=id,courseId,name,ultraStatus,closedComplete` | read | Private source tool | `unknown` | `api_configured_live_untested` |
| `blackboard_apply_reviewed_ultra_assignment` | assignments | `POST /learn/api/public/v1/courses/{course_id}/contents/createAssignment` | write | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_verify_ultra_assignment` | assignments | `GET /learn/api/public/v2/courses/{course_id}/gradebook/columns` | read | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_list_course_announcements` | announcements | `GET /learn/api/public/v1/courses/{course_id}/announcements` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_read_course_announcement` | announcements | `GET /learn/api/public/v1/courses/{course_id}/announcements/{announcement_id}` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_plan_course_announcement` | announcements | `GET /learn/api/public/v1/courses/{course_id}/announcements` | read | Private source tool | `unknown` | `api_configured_live_untested` |
| `blackboard_apply_reviewed_course_announcement` | announcements | `POST /learn/api/public/v1/courses/{course_id}/announcements` | write | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_verify_course_announcement` | announcements | `GET /learn/api/public/v1/courses/{course_id}/announcements` | read | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_plan_course_announcement_patch` | announcements | `GET /learn/api/public/v1/courses/{course_id}/announcements/{announcement_id}` | read | Private source tool | `unknown` | `api_configured_live_untested` |
| `blackboard_apply_reviewed_course_announcement_patch` | announcements | `PATCH /learn/api/public/v1/courses/{course_id}/announcements/{announcement_id}` | write | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_verify_course_announcement_patch` | announcements | `GET /learn/api/public/v1/courses/{course_id}/announcements/{announcement_id}` | read | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_list_course_groups` | groups | `GET /learn/api/public/v2/courses/{course_id}/groups` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_list_course_group_sets` | groups | `GET /learn/api/public/v2/courses/{course_id}/groups/sets` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_read_course_group` | groups | `GET /learn/api/public/v2/courses/{course_id}/groups/{group_id}` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_list_group_members` | groups | `GET /learn/api/public/v1/courses/{course_id}/groups/{group_id}/users` | read | Full surface, or `morrow_capability_read` | `unknown` | `api_configured_live_untested` |
| `blackboard_plan_course_group` | groups | `GET /learn/api/public/v2/courses/{course_id}/groups` | read | Private source tool | `unknown` | `api_configured_live_untested` |
| `blackboard_apply_reviewed_course_group` | groups | `POST /learn/api/public/v2/courses/{course_id}/groups` | write | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_verify_course_group` | groups | `GET /learn/api/public/v2/courses/{course_id}/groups` | read | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_plan_course_group_patch` | groups | `GET /learn/api/public/v2/courses/{course_id}/groups/{group_id}` | read | Private source tool | `unknown` | `api_configured_live_untested` |
| `blackboard_apply_reviewed_course_group_patch` | groups | `PATCH /learn/api/public/v2/courses/{course_id}/groups/{group_id}` | write | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_verify_course_group_patch` | groups | `GET /learn/api/public/v2/courses/{course_id}/groups/{group_id}` | read | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_plan_group_membership` | groups | `GET /learn/api/public/v1/courses/{course_id}/groups/{group_id}/users` | read | Private source tool | `unknown` | `api_configured_live_untested` |
| `blackboard_apply_reviewed_group_membership` | groups | `PUT /learn/api/public/v1/courses/{course_id}/groups/{group_id}/users/{user_id}` | write | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_verify_group_membership` | groups | `GET /learn/api/public/v1/courses/{course_id}/groups/{group_id}/users` | read | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_plan_group_membership_removal` | groups | `GET /learn/api/public/v1/courses/{course_id}/groups/{group_id}/users` | read | Private source tool | `unknown` | `api_configured_live_untested` |
| `blackboard_apply_reviewed_group_membership_removal` | groups | `DELETE /learn/api/public/v1/courses/{course_id}/groups/{group_id}/users/{user_id}` | write | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_verify_group_membership_removal` | groups | `GET /learn/api/public/v1/courses/{course_id}/groups/{group_id}/users` | read | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_plan_course_availability` | course-lifecycle | `GET /learn/api/public/v3/courses/{course_id}?fields=id,courseId,name,ultraStatus,closedComplete,availability` | read | Private source tool | `unknown` | `api_configured_live_untested` |
| `blackboard_apply_reviewed_course_availability` | course-lifecycle | `PATCH /learn/api/public/v3/courses/{course_id}` | write | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_verify_course_availability` | course-lifecycle | `GET /learn/api/public/v3/courses/{course_id}?fields=id,courseId,name,ultraStatus,closedComplete,availability` | read | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_plan_content_dated_visibility` | course-lifecycle | `GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}` | read | Private source tool | `unknown` | `api_configured_live_untested` |
| `blackboard_apply_reviewed_content_dated_visibility` | course-lifecycle | `PATCH /learn/api/public/v1/courses/{course_id}/contents/{content_id}` | write | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_verify_content_dated_visibility` | course-lifecycle | `GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}` | read | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_course_copy` | course-lifecycle | None. Sends no Blackboard request. | read | Private source tool | `none` | `api_configured_live_untested` |
| `blackboard_plan_content_patch` | content-patch | `GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}` | read | Private source tool | `unknown` | `api_configured_live_untested` |
| `blackboard_apply_reviewed_content_patch` | content-patch | `PATCH /learn/api/public/v1/courses/{course_id}/contents/{content_id}` | write | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_verify_content_patch` | content-patch | `GET /learn/api/public/v1/courses/{course_id}/contents/{content_id}` | read | Gateway dispatch only | `unknown` | `api_configured_live_untested` |
| `blackboard_unresolved_effects` | effect-receipts | None. Sends no Blackboard request. | read | Full surface, or `morrow_capability_read` | `none` | `api_configured_live_untested` |

Reading the table:

- **Reachable from.** A public tool answers under its own name in the `full`
  tool surface, and under that same name through `morrow_capability_read` in the
  `compact` surface the desktop app configures. A private source tool is hidden
  from Morrow's merged catalog: no MCP client can discover or call it. A
  Gateway-dispatch-only tool is registered only when the Gateway starts this
  server for its own reserved dispatch.
- **Reviewed changes.** Morrow exposes 14 reviewed Blackboard action planners: `morrow_plan_blackboard_membership_patch`, `morrow_plan_blackboard_gradebook_column_patch`, `morrow_plan_blackboard_gradebook_grade_patch`, `morrow_plan_blackboard_content_attachment`, `morrow_plan_blackboard_ultra_assignment`, `morrow_plan_blackboard_course_announcement`, `morrow_plan_blackboard_course_announcement_patch`, `morrow_plan_blackboard_course_group`, `morrow_plan_blackboard_course_group_patch`, `morrow_plan_blackboard_group_membership`, `morrow_plan_blackboard_group_membership_removal`, `morrow_plan_blackboard_course_availability`, `morrow_plan_blackboard_content_dated_visibility`, `morrow_plan_blackboard_content_patch`. Each planner freezes the exact selected course, account, credential generation and change. It sends no course write. Approval permits one dispatch, followed by a fresh saved-result comparison. The source apply and verification tools remain private.
- **A change is bound to the connection it was reviewed under.** Every plan
  carries an effect binding scope: the site, the course connection, a fingerprint
  of the integration account and its credential, and a session generation. Morrow
  counts that generation in `~/.morrow/blackboard-sessions.json`
  (`MORROW_BLACKBOARD_SESSION_STATE` moves it), one counter for each site and
  integration account, raised whenever the credential, the account Blackboard
  reports for it, or the site changes, and never lowered. The Gateway requires a
  generation of 1 or more, freezes it into the reserved change, and the source
  refuses to dispatch under any other connection: a change reviewed before a
  secret rotation or a repointed integration user is refused after it, with
  nothing sent. That record holds digests only, never the application key or
  secret, and while it cannot be read or written Morrow keeps reading Blackboard
  and refuses every change.
- **A receipt is one-use for this installation, not for this process.** Morrow
  writes every spent effect receipt to `~/.morrow/blackboard-effects.json`
  (`MORROW_BLACKBOARD_EFFECT_STATE` moves it), keyed by the Gateway process that
  minted the grant and the receipt in it, with the phase that dispatch reached:
  `reserved` before anything left this process, `sent` written immediately before
  the change request leaves it, then `verified` or `uncertain`. A replayed grant
  is refused from that record, so a restart of this server under a Gateway that
  is still running does not make a spent receipt usable again. Settled rows are
  dropped after thirty days; an unresolved row is never dropped by age.
- **An unconfirmed change holds the item it was sent to.** While a row is `sent`
  or `uncertain` with no fresh-read finding, Morrow refuses a new change to that
  exact course and content item — at review time, so nobody is asked to approve a
  change Morrow would then refuse. `blackboard_unresolved_effects` lists those
  changes with the operation id, the phase, and the item to open. Only the
  fresh-read comparator releases one, and it is a read: it states what Blackboard
  holds now, whichever way that comes out, and Morrow never sends the change
  again. When that record cannot be read or written, Morrow keeps reading
  Blackboard and refuses every change, and `blackboard_unresolved_effects`
  refuses rather than answering "there are none".
- **The grant secret exists for one Gateway process.** The Gateway mints
  `MORROW_BLACKBOARD_EFFECT_DISPATCH_SECRET` with `randomBytes(32)` for each of
  its own processes and passes it to this server as an environment variable
  (`packages/mcp-server/src/runtime.ts`). Nothing writes it to a file or to an
  operation record, so a grant signed under an earlier Gateway process cannot be
  dispatched by a later one. `packages/blackboard-learn-api/test/blackboard-effect-receipts.test.ts`
  proves the refusal and that the effect record holds no secret and no dispatch
  token; `packages/mcp-server/test/blackboard-gateway.integration.test.ts` proves
  the saved operation record holds neither.
- **Cost.** Every course route also sends the integration-account read, the
  course-membership read, and, where redaction needs one, the course roster read
  before it answers. One content read is therefore more than one Learn request.
- **`blackboard_apply_reviewed_content_attachment`** stages the file at
  `POST /learn/api/public/v1/uploads` first, then attaches the staged id.
- **`blackboard_apply_reviewed_ultra_assignment`** makes a content item and
  the gradebook column that grades it in one request, and re-reads both by the
  ids Blackboard returned. It refuses a course Blackboard does not report as
  Ultra before it sends anything.
- **`blackboard_apply_reviewed_course_announcement`** and
  **`blackboard_apply_reviewed_course_announcement_patch`** are the two routes
  that declare `behavior.irreversible: true`. Blackboard can notify every
  enrolled learner when an announcement is posted, whether a given site sends
  e-mail for one is a setting on that site, and Morrow holds no route that
  recalls a sent announcement.
- **The course-announcement path is resolved against the site, never assumed.**
  No tenant Swagger has been read, so every announcement route reads
  `/learn/api/public/v1/courses/{course_id}/announcements` first. A site that
  answers `404` or `405` there gets `blackboard_operation_unavailable` naming
  that path. Morrow never falls back to the site-wide
  `/learn/api/public/v1/announcements` collection, which would reach the whole
  Learn site instead of one course, and it guesses no other path.
- **The Learn version of the group routes is resolved against the site, never
  assumed.** No tenant Swagger has been read, so Morrow assumes neither version:
  every group read asks `v2` first and falls back to `v1` only when the site
  answers `404` or `405`. Each group
  result records the version that answered, and a site that answers neither gets
  `blackboard_operation_unavailable` naming both paths. Group memberships are
  read and written at `v1` and at no other version: a `404` on a version Morrow
  guessed cannot be told apart from a person who is not in the group. Which
  version a given Learn site answers is live-unverified.
- **`blackboard_apply_reviewed_group_membership_removal`** is the one route that
  sends a `DELETE`. It takes one person out of one group and never out of the
  course, it refuses a person the group does not hold, and its readback re-reads
  the group and everyone in it.
- **`morrow_blackboard_health`** sends no Blackboard request at all. It reports
  what is configured, which is not a live connection.

## Entitlements

Every Learn route above is recorded as `unknown`. Anthology lists the endpoint
entitlement for each route in the tenant's own Swagger, and pins its published
API set to a Learn version, so an entitlement read from a different site or a
different version is not evidence about the target site. No tenant Swagger has
been read, so nothing here is filled in and nothing is guessed. The acceptance
runbook below is where the list gets completed.

`morrow_blackboard_health` is `none`: it needs no entitlement because it makes no
request.

## Reviewed action limits

Blackboard supports reviewed content metadata and dated visibility, course availability, an existing membership role or availability, gradebook column settings and a person’s score or grade text, one workspace file attachment, a new Ultra assignment, announcement creation and editing, group creation and editing, and group membership addition and removal. File attachments use one workspace file of at most 1 MiB. Blackboard can notify enrolled learners when an announcement is posted; Morrow cannot recall those notifications. Creating an Ultra assignment also creates its gradebook column, and Morrow has no undo route for either. Content metadata changes are limited to a `resource/x-bb-document` item’s title, description and availability. Document bodies, tests, questions, question banks, discussions, forums, course copy, course enrolment creation or removal, standalone gradebook column creation or deletion, and group or group-set deletion remain unavailable. These limits follow the current implementation and the documented REST contract; no live tenant has been tested.

Learner references are encrypted in `blackboard-learners.json` beside the session state. Approved personal changes can resume after a source restart under the same connection. Lost file stages are cancelled before dispatch and require a new file plan.

## Held operations, and why

| Held | State | Reason |
| --- | --- | --- |
| Adding or removing a person from a course (`PUT` and `DELETE` on the membership route) | Not implemented | Morrow has no reviewed contract for adding or removing a person from a course. |
| Creating a gradebook column (`POST` on the columns route) | Not implemented | It needs its own frozen request and a readback that re-reads the created column by the id the site returned. This module sends neither. |
| Deleting a gradebook column (`DELETE` on the column route) | Not implemented | Deleting a column removes every grade in it and Morrow holds no undo contract for that. |
| Changing feedback, notes, or an exemption on a grade | Refused before any request | `blackboard_response_invalid`. A Blackboard grade change sets the score, the grade text, or both. |
| The deprecated `v1` gradebook routes | Not called | Morrow calls the `v2` gradebook routes and does not fall back. A 404 from a site cannot be told apart from a 404 for a column that does not exist, and a second request after a change has left Morrow would be a second dispatch. |
| A document `body` change | Refused before any request | `blackboard_operation_unavailable`. Original HTML and Ultra BbML need separate reviewed contracts, and a plain-text body patch on an Ultra document would overwrite its BbML. |
| Tests, questions, and question banks | No route in the public API | Anthology removed adding questions to an assignment through the REST API in Learn 3900.98, and its public documentation lists no test or question-bank route. A test appears only as a `resource/x-bb-asmt-test-link` content item, which `blackboard_read_course_assessment` reads. A request that names questions is refused with `blackboard_operation_unavailable` and that reason, before any Blackboard request. Source: [Ultra assignments](https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/ultra-assignments). |
| Changing an assignment's points possible or its due date | Not a separate route | Both live on that assignment's gradebook column, and `blackboard_plan_gradebook_column_patch` reviews that change. Morrow adds no second writer for them. |
| Attaching a file to an assignment as it is created | Not implemented | The create request Morrow sends carries no file. A file goes on a `resource/x-bb-document` item through `blackboard_plan_content_attachment`. |
| Discussions and forums | No route in the public API | Anthology's public documentation lists no discussion or forum route. A forum appears only as a `resource/x-bb-forumlink` content item. |
| An announcement that names a person on the course roster | Refused before review | `blackboard_operation_unavailable`. An announcement reaches every enrolled learner, and Morrow shows a roster identity as a protected reference, so the text a person would approve would not be the text Blackboard receives. |
| Deleting an announcement | Not implemented | Removing an announcement does not take back a notification a learner already received, and Morrow holds no reviewed contract for it. |
| Deleting a group (`DELETE` on the group route) | Not implemented | Morrow can read whether a group has members, but the public Learn REST API gives it no route that says whether the group still holds group content or work a learner submitted through it, and Morrow holds no route that restores a deleted group. |
| Deleting a group set (`DELETE` on the group-set route) | Not implemented | The public Learn REST API gives Morrow no route that says what deleting a group set does to the groups inside it, and Morrow holds no undo contract for it. |
| Creating a group inside a named group set (`POST` on the group-set children route) | Not implemented | The create request Morrow sends carries no group set. A group it makes belongs to whichever set the site puts it in, and the readback reports that set. |
| A course window Morrow does not model: a term, and a fixed number of days from each learner's enrolment | Refused before any request | `blackboard_response_invalid`. Morrow sends `Continuous` or `DateRange` with exact dates. Both other values decide when learners reach a course from a record Morrow has not read. |
| Copying a course (`blackboard_course_copy`) | Registered as a private source tool, unavailable in every profile | A course copy is a long-running Blackboard operation: it needs one route that starts the copy and a separate resource that reports whether it finished. No tenant Swagger has been read here to confirm either, so the tool sends no Blackboard request and names what is missing. No path is guessed. Its capability is unavailable in every profile, so the Gateway holds it out of the catalog and publishes that reason through `morrow_profile_status`; a public name would answer nowhere. |
| Reading a group membership record without an `id` | Refused | Morrow reads group memberships through the same guarded collection reader as every other Blackboard collection, which requires each record to carry an `id`. Whether a Learn site returns one on a group membership record is not settled by Anthology's public documentation and is untested. A site that returns records without one gets `blackboard_response_incomplete` rather than a list Morrow cannot check. |
| The browser (Bridge) path | Not implemented | `connector/extension/src/blackboard-session.js` was removed on 6 September 2026. Its 3LO PKCE token exchange was never proved without an application secret, and a secret must not ship in an extension. Connecting a Blackboard tab in Chrome is refused by name, sends nothing to the site, saves no connection, and gives back the site access Chrome had just granted for it; `scripts/test/blackboard-browser-route.test.mjs` runs that refusal. The contract is kept in [blackboard-recovery-contract.md](../research/blackboard-recovery-contract.md). |

## Live-tenant acceptance runbook

Nothing in this checkout can produce live evidence. This is the sequence to run
the day a tenant exists, and the record it has to leave behind.

**Before the run**

1. A Learn administrator registers the application, notes its Application ID,
   and installs it on the target site against a named Learn user. Record that
   user and whether End User Access is on.
2. Export the site's Swagger. For every route in the inventory above, record the
   endpoint entitlement it needs and grant exactly those to that user's system
   role. Replace `unknown` in this document with what the Swagger says. Do not
   guess an entitlement.
3. Create one disposable course that no learner uses, holding one
   `resource/x-bb-document` item, one `resource/x-bb-folder`, and one Ultra
   document wrapper, so the refusals can be checked as well as the reads.
4. Set Morrow up through the desktop app's Blackboard panel, or write the setup
   and credential files by hand with private permissions.

**The read sequence, which changes nothing**

5. `morrow_blackboard_health`: confirm the tenant, the account, and the course
   binding Morrow derived. Configured is not connected.
6. `blackboard_read_integration_account`: confirm the account Learn resolves is
   the configured one. If the site does not answer `users/me`, record that, set
   `principalVerification: "membership-only"`, and note that every change stays
   refused for that tenant.
7. Run each remaining read once against the disposable course:
   `blackboard_read_course`, `blackboard_get_course_availability`,
   `blackboard_list_course_contents`, `blackboard_list_content_children`,
   `blackboard_inventory_course_contents`, `blackboard_read_course_content`,
   `blackboard_list_content_attachments`, `blackboard_read_content_attachment`,
   `blackboard_course_roster_summary`, `blackboard_read_course_membership`,
   `blackboard_list_my_courses`, `blackboard_list_gradebook_columns`,
   `blackboard_read_gradebook_column`, `blackboard_list_gradebook_attempts`,
   `blackboard_read_gradebook_attempt`, and `blackboard_read_gradebook_grade`.
   Record the HTTP status, the fields the site returned, and every field Morrow
   reported as absent. The gradebook reads settle two open questions: whether the
   site serves the `v2` gradebook routes at all, and which of the fields Morrow
   asks each of them for it answers.
8. Record the transport facts the local fixtures can only simulate: the exact
   rate-limit header names the site returns on a 429, whether any read answers
   201 or 204, and the page size the site enforces.

**One change**

9. Plan one title change on the disposable document with
   `morrow_plan_blackboard_content_patch`. Open the review page and confirm it
   names the course and the item rather than a digest.
10. Approve and dispatch. Exactly one PATCH must leave Morrow.
11. Confirm the readback, then open the item in Blackboard and inspect the
    screen. A verified receipt is not a screen inspection.
12. Record whether Learn merged or replaced the nested `availability` object.
    The local fixtures cannot settle it, and the protected-field freeze is the
    only safeguard until they do.
13. Check each refusal, and confirm that none of them sends a PATCH: a folder
    target, an Ultra wrapper, a `body` patch, a course that is closed and
    complete, a replayed dispatch, and a plan whose item changed between review
    and dispatch.

**After the run**

14. Replace every `unknown` entitlement, record the Learn version the site
    reports, and date the result in this document. Only then may any Morrow
    surface state a live Blackboard result; until then
    [LIMITATIONS.md](../../LIMITATIONS.md) keeps its sentence that no live
    Blackboard tenant has been tested.
15. Take the disposable connection off the computer with **Remove connection**
    in the desktop app's Blackboard panel. It removes that tenant from
    `blackboard-learn.json`, deletes its `<tenant id>.secret` file, reads both
    again, and reports what is left. It sends no request to Blackboard.

## Focused tests

These are the tests that prove this document's own claims. Each was run under
the shared lock on this checkout on 7 September 2026. Each command names its
files by pattern, so every Blackboard test file in the checkout is run by one of
them.

| Command | Result on 7 September 2026 |
| --- | --- |
| `pnpm --dir packages/blackboard-learn-api exec vitest run` | 213 of 213 pass, in 18 files. Proves this server's own contract: the course binding, the account check, the privacy boundary, the read cost, the transport bounds, the operation registry, and, for each reviewed change, one dispatch with a fresh readback. The gradebook file proves one dispatch per reviewed change, the refusal before a stale grade is written, the `applied_or_unknown` a mismatched readback reports, the bounded attempt pagination, and that no learner name, e-mail address, submitted work, or feedback reaches a result. The assignments file proves one create request per approved plan, that the readback re-reads both the created content item and its gradebook column by the ids Blackboard returned, that a gradebook column Blackboard did not name or Morrow could not read leaves the result `applied_or_unknown`, and that a request to add a question is refused with the 3900.98 removal as the reason and sends nothing. The announcements file proves one create request per approved plan, that a replayed grant sends nothing, that the readback names every frozen field it compared and every one the site did not return, that a learner named in an announcement leaves as a protected reference, that an announcement naming a person on the course roster is refused before review, and that a site which does not answer the course-announcement collection is reported as `blackboard_operation_unavailable` with no request to any other path. The effect-scope file proves the session generation this document describes: a change reviewed before a credential rotation is refused after it with nothing sent, the generation rises on every credential change and never falls, a restart on the same credential is the same session, the account Blackboard reports for the credential moves it, and a record Morrow cannot use leaves reads working and refuses every change. The effect-receipts file proves the durable record: a receipt spent before a restart of this server is refused after it with no second PATCH, a change that left Morrow without a confirmed outcome holds its exact item across a restart until one explicit fresh read settles it and never a repeat of the change, `blackboard_unresolved_effects` names the operation and the item to open and refuses rather than answering "there are none" when the record cannot be read, a grant signed under another Gateway process is refused with nothing sent and no receipt spent, the record holds no dispatch secret, no grant token, and no learner detail, and a settled row is dropped after its retention window while an unconfirmed one is kept. The course-lifecycle file proves one PATCH per approved availability, course-window, or dated-visibility change, that the plan states who gains or loses access, that a course field somebody else changed between review and dispatch is refused with nothing sent, that a readback names every frozen value the change could move and did not compare, that a cleared date reads back as cleared whether the site drops the field or answers it as null, and that course copy sends no request at all and names what a tenant would have to confirm. |
| `pnpm --dir packages/mcp-server exec vitest run test/blackboard-` | 19 of 19 pass, in 6 files. Proves the reachability this document's table states in both tool surfaces, the Gateway effect path and its one approved PATCH, that the Gateway refuses a Blackboard source reporting no counted session and freezes the generation of one that does, the execution state a refusal and an unconfirmed change each record, the approval review page, and the course audit. |
| `node --test scripts/test/blackboard-*.test.mjs` | 16 of 16 pass, in 2 files. Holds the route inventory, its counts, the README surface, and this section to the operation registry, and fails when a Blackboard claim waits on a browser connection or claims a live tenant. It also runs the Bridge refusal itself: a Blackboard tab is refused by name, nothing reaches the site, no connection is saved, the site access that attempt was granted goes back, and the access Morrow already held stays. |
| `node --test installer/test/blackboard*.test.cjs` | 22 of 22 pass. Proves the local setup-file and credential transaction, its private file modes, its rollback, and the removal of one saved connection: its entry and its secret go, another saved connection is untouched, a name no configuration carries changes nothing, and a secret that is still on the computer is reported as still there. |
| `node --test scripts/test/product-claims.test.mjs` | 8 of 8 pass. Holds README, LIMITATIONS, ARCHITECTURE, and the brand document to their sources, including the untested-tenant sentence and every repository link. |

### Running the suite

Build once first, because the Gateway tests load built workspace packages.

```sh
pnpm -r --if-present build
pnpm --dir packages/blackboard-learn-api exec vitest run
pnpm --dir packages/mcp-server exec vitest run test/blackboard-
node --test scripts/test/blackboard-*.test.mjs
node --test installer/test/blackboard*.test.cjs
```

`vitest run test/blackboard-` filters by path, and each `node --test` command
takes a shell glob, so a Blackboard test file added later runs without an edit
here. `scripts/test/blackboard-doc-consistency.test.mjs` fails when a Blackboard
test file is added where none of these commands would reach it, and when this
section runs a file the checkout does not have. This suite is not part of
`pnpm check`, and nothing was added to `pnpm check` for it.

The files those four commands ran on 7 September 2026:

- `pnpm --dir packages/blackboard-learn-api exec vitest run` ran
  `packages/blackboard-learn-api/test/blackboard-announcements.test.ts`,
  `packages/blackboard-learn-api/test/blackboard-assignments.test.ts`,
  `packages/blackboard-learn-api/test/blackboard-course-contents.test.ts`,
  `packages/blackboard-learn-api/test/blackboard-dispatch-state.test.ts`,
  `packages/blackboard-learn-api/test/blackboard-files.test.ts`,
  `packages/blackboard-learn-api/test/blackboard-gradebook.test.ts`,
  `packages/blackboard-learn-api/test/blackboard-learn-api.integration.test.ts`,
  `packages/blackboard-learn-api/test/blackboard-memberships.test.ts`,
  `packages/blackboard-learn-api/test/blackboard-principal.test.ts`,
  `packages/blackboard-learn-api/test/blackboard-privacy.test.ts`,
  `packages/blackboard-learn-api/test/blackboard-read-cost.test.ts`,
  `packages/blackboard-learn-api/test/blackboard-registry.test.ts`,
  `packages/blackboard-learn-api/test/blackboard-transport.test.ts`, and
  `packages/blackboard-learn-api/test/config.test.ts`.
- `pnpm --dir packages/mcp-server exec vitest run test/blackboard-` ran
  `packages/mcp-server/test/blackboard-approval-review.test.ts`,
  `packages/mcp-server/test/blackboard-course-audit.test.ts`,
  `packages/mcp-server/test/blackboard-dispatch-state.integration.test.ts`,
  `packages/mcp-server/test/blackboard-egress-scope.test.ts`,
  `packages/mcp-server/test/blackboard-gateway.integration.test.ts`, and
  `packages/mcp-server/test/blackboard-surface-reachability.test.ts`.
- `node --test scripts/test/blackboard-*.test.mjs` ran
  `scripts/test/blackboard-browser-route.test.mjs` and
  `scripts/test/blackboard-doc-consistency.test.mjs`.
- `node --test installer/test/blackboard*.test.cjs` ran
  `installer/test/blackboard.test.cjs`.

The lane plan also named a `blackboard-session` test under `scripts/test/`. It
went with the browser path on 6 September 2026, so no command runs it.
`scripts/test/blackboard-browser-route.test.mjs` took its place: it holds the
refusal that stands where that module was, rather than a module that is gone.

### Blackboard cases in other lanes' test files

These files belong to other lanes and run in those lanes' suites. Each holds at
least one named Blackboard case, so a Blackboard change should run them too.

| Command | Blackboard cases it holds | Result on 7 September 2026 |
| --- | --- | --- |
| `node --test installer/test/renderer.test.cjs installer/test/setup-view.test.cjs installer/test/contract.test.cjs installer/test/state-policy.test.cjs` | The desktop Blackboard form, its field rules, its public state, the saved connection's Remove action, and the secret's place in uninstall | 51 of 51 pass, in 4 files |
| `pnpm --dir packages/mcp-server exec vitest run test/config.test.ts` | Registering the private Blackboard source only when its setup file exists | 8 of 8 pass |
| `node --test scripts/test/bridge-release-provider-scope.test.mjs scripts/test/popup-view.test.mjs` | That the packaged Bridge ships no Blackboard module, and that the Chrome popup states the REST route and its untested state | 12 of 12 pass, in 2 files |

### How these files reach the repository gate

This repository has no test manifest and no `test:manifest` command, so there is
nothing to register a new Blackboard test file in. Every runner finds its files
by pattern, and a file saved in one of these places is already in the gate:

- `packages/blackboard-learn-api` and `packages/mcp-server` each run `vitest run`
  from their own `package.json`, which collects every test file in the package.
- `pnpm scripts:test` runs `node --test scripts/test/*.test.mjs`.
- `pnpm test:desktop` runs the installer's own `node --test test/*.test.cjs
  test/*.test.mjs`.

`pnpm check` is `pnpm test`: `pnpm build`, then `pnpm -r --if-present test`,
then `pnpm scripts:test`, then `pnpm test:desktop`. Every file above already
runs inside it.
