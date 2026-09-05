# Lesson review, Moodle, and Blackboard

Implementation checkpoint: September 4, 2026. This extends the Revision 3 weekend plan. It does not replace its remaining release gates.

## Goal

Add a source-grounded lesson and quiz review. Add useful Moodle and Blackboard work to the same local Morrow installation. Keep one approval and execution path.

## Requirements

- R1: Two separate model requests compare the selected lesson and quiz with the educator's source. A third request checks their findings. Keep exact evidence and disagreements. These model judgments require educator review.
- R2: Use the AI client's MCP sampling support. Do not require another model service or pretend that developer subagents are product features. Refuse an unsupported client before reading Canvas.
- R3: Bind review state to the input and session. Reject changed, expired, tampered, incomplete, or mismatched results. Model requests have no tools or write authority.
- R4: Read Moodle courses, contents, assignments, and quiz settings. Change one course description with exact before-state and after-state checks.
- R5: Read Blackboard courses, top-level content, and one direct child page. Change the title or body of an exact supported document. Preserve other fields. Do not change an Ultra document wrapper as if it were its body.
- R6: Keep credentials in a private local connection file, outside chat arguments and results. Fix the destination to the saved HTTPS address. Do not follow redirects or retry writes.
- R7: Use the existing frozen plan, local human approval, durable effect reservation, automatic execution, and result check. Reject a changed account or item before sending. Do not resend a dispatched operation.
- R8: Show course and item names, a readable content preview, and the correct platform name in the review. Hide hashes and connection identifiers in technical details.

## Implemented scope

| Platform | Available in this checkpoint | Not included |
| --- | --- | --- |
| Canvas review | `morrow_review_lesson`: one selected page and New Quiz against supplied source text; two specialist requests and one checker | Essays, rubrics, bank draws, media, accessibility, learner launch checks, automatic adoption of proposals |
| Moodle REST | Five reads: own courses, exact course, contents, assignment settings, and quiz settings. One change: exact course-summary replacement. | General activity or question authoring; browser-session transport; live-tenant proof. |
| Blackboard REST | Five reads: own course memberships, exact course, top-level content, direct content children, and exact content. One change: title/body of one exact `resource/x-bb-document`. | Recursive inventory, assessment or bank authoring, browser-cookie authentication, OAuth registration or token renewal, and live-tenant proof. |

The Canvas review accepts up to 40 directly saved choice, multiple-answer, or true/false questions with complete saved answer settings. The source is limited to 40,000 characters. The lesson is limited to 40,000 characters. Oversized or incomplete evidence is refused, not silently truncated. The review reports client-supplied model names; Morrow does not attest model identity. Separate requests may use the same model.

The current code uses the SDK's unified input-required workflow. Tests exercise both legacy server-to-client sampling and the current named-input protocol. An actual supported chat client and real model response are still required for launch proof.

## Connection contract

The user setup, placeholder schema, custom-upstream object, and first reads are
in the [README](../../README.md#private-moodle-and-blackboard-preview). Fresh
local setup includes the bundled `lms-api` stdio source. A custom
`morrow.upstreams.json` must retain its current entries and add that source.
`public-canvas` does not expose these tools.

| Provider | Runtime authorization and transport | Write rule |
| --- | --- | --- |
| Moodle | `core_webservice_get_site_info` must return the saved HTTPS address, a user ID, and the service functions required by the selected tool. Requests use REST `POST` with the token in form data and `moodlewssettingraw=true`. | The service and user need `core_course_update_courses`, `moodle/course:update`, and `moodle/course:changesummary` for the course-summary tool. Function listing is not course permission. |
| Blackboard | The saved HTTPS-root connection needs a delegated bearer token and the same OAuth user UUID. The adapter resolves that UUID and confirms one current-user membership before each operation. | Only a verified `resource/x-bb-document` can change. Blackboard documents an Ultra body as a child of an `isBbPage=true` `resource/x-bb-folder`; `blackboard_list_content_children` reads a selected parent, requests one non-recursive page, and sets `skipUltraDocumentBodyAndKnowledgeChecks=false`. |

Before a change, Morrow rereads the exact target and checks snapshot and
connection digests. It sends once, then makes a fresh provider read and compares
the requested and protected fields. There is no atomic edit lock. A result that
cannot be confirmed after send remains `applied_or_unknown` and is not retried.

## Official API research

- [Moodle external-service setup](https://docs.moodle.org/502/en/Using_web_services) defines service functions, tokens, and user access.
- [Moodle external-function declarations](https://moodledev.io/docs/5.2/apis/subsystems/external/description) distinguish REST service inclusion from `ajax:true` browser access.
- [Moodle 5.2.2 course external API](https://github.com/moodle/moodle/blob/v5.2.2/public/course/externallib.php) defines course reads and updates.
- [Moodle call settings](https://github.com/moodle/moodle/blob/v5.2.2/public/webservice/lib.php) define raw output formatting.
- [Blackboard Learn 4000.21.0 schema](https://devportal-docstore.s3.amazonaws.com/learn-swagger-4000.21.0.json) defines the supported REST routes and permissions.
- [Blackboard current-user course mapping](https://blackboard.github.io/rest-apis/learn/advanced/soap-to-rest-mapping) documents `/users/me/courses`.
- [Blackboard content handlers](https://docs.blackboard.com/docs/blackboard/rest-apis/advanced/content-handler) define the `resource/x-bb-document` body and the `resource/x-bb-folder` Ultra wrapper.

Moodle's external-service documentation governs service exposure, tokens, and
user permissions. Blackboard's documented token exchange requires application
credentials. This private preview has no token exchange or renewal path, and a
public Chrome extension must not embed a vendor secret.

## Evidence and remaining work

| Provider | Current evidence | Claim limit |
| --- | --- | --- |
| Moodle | Official Moodle 5.2.2 API contracts match all six tools. `moodle-api.test.ts`, `lms-api.integration.test.ts`, `lms-connections.test.ts`, `config.test.ts`, and `public-profile-config.test.ts` passed: 17 tests in 5 files. | Documented API and adapter validation for controlled course-summary editing. All provider responses are mocked or local fixtures; this is not live Moodle compatibility or broad authoring proof. |
| Blackboard | Official Learn schema and content-handler contracts support the six tools. Blackboard API, LMS adapter, and configuration tests cover the current path, including direct-child discovery. | Documented API and adapter validation only. No Blackboard tenant, delegated OAuth exchange, or live course readback has run. |

The next proof is an authorized provider connection: list the saved connection,
read one exact course, and retain the raw read result. A later approved change
needs its own plan, single-send receipt, and fresh provider readback. Do not
repeat a request after `applied_or_unknown`.

## Local verification after a configured connection

Use `morrow_lms_connections` without logging credentials. A saved connection is
not a live-access receipt. Healthy reads return the requested provider, exact
course target, `snapshot_digest`, and `connection_digest`. Stop provider writes
after missing identity, changed snapshots, an unintended protected-field change,
or `applied_or_unknown`. Inspect the provider and create a new approved
correction only when the previous result is understood.
