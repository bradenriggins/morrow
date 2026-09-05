# Lesson review, Moodle, and Blackboard

Implementation checkpoint: September 4, 2026. This extends the Revision 3 weekend plan. It does not replace its remaining release gates.

## Goal

Add a source-grounded lesson and quiz review. Add useful Moodle and Blackboard work to the same local Morrow installation. Keep one approval and execution path.

## Requirements

- R1: Two separate model requests compare the selected lesson and quiz with the educator's source. A third request checks their findings. Keep exact evidence and disagreements. These model judgments require educator review.
- R2: Use the AI client's MCP sampling support. Do not require another model service or pretend that developer subagents are product features. Refuse an unsupported client before reading Canvas.
- R3: Bind review state to the input and session. Reject changed, expired, tampered, incomplete, or mismatched results. Model requests have no tools or write authority.
- R4: Read Moodle courses, contents, assignments, and quiz settings. Change one course description with exact before-state and after-state checks.
- R5: Read Blackboard courses and content. Change the title or body of an exact supported document. Preserve other fields. Do not change an Ultra document wrapper as if it were its body.
- R6: Keep credentials in a private local connection file, outside chat arguments and results. Fix the destination to the saved HTTPS address. Do not follow redirects or retry writes.
- R7: Use the existing frozen plan, local human approval, durable effect reservation, automatic execution, and result check. Reject a changed account or item before sending. Do not resend a dispatched operation.
- R8: Show course and item names, a readable content preview, and the correct platform name in the review. Hide hashes and connection identifiers in technical details.

## Implemented scope

| Platform | Available in this checkpoint | Not included |
| --- | --- | --- |
| Canvas review | `morrow_review_lesson`: one selected page and New Quiz against supplied source text; two specialist requests and one checker | Essays, rubrics, bank draws, media, accessibility, learner launch checks, automatic adoption of proposals |
| Moodle REST | Own courses, exact course, course contents, assignment settings, quiz settings, course-description replacement | General activity or question authoring; browser-session transport |
| Blackboard REST | Own course memberships, exact course, top-level content, exact content, document title/body changes | General assessment or bank authoring; browser-cookie authentication; OAuth registration and token exchange |

The Canvas review accepts up to 40 directly saved choice, multiple-answer, or true/false questions with complete saved answer settings. The source is limited to 40,000 characters. The lesson is limited to 40,000 characters. Oversized or incomplete evidence is refused, not silently truncated. The review reports client-supplied model names; Morrow does not attest model identity. Separate requests may use the same model.

The current code uses the SDK's unified input-required workflow. Tests exercise both legacy server-to-client sampling and the current named-input protocol. An actual supported chat client and real model response are still required for launch proof.

## Connection contract

Fresh local setup and the default local gateway start the bundled LMS API source. No extra package or service must be installed. Existing custom upstream files stay unchanged and must explicitly include that source. The `public-canvas` runtime profile does not expose Moodle or Blackboard tools.

The source reads `~/.morrow/lms-connections.json`, or the path in `MORROW_LMS_CONNECTIONS_FILE`. The file must use private owner-only permissions on macOS/Linux. Windows file-access controls still require installation-level verification. Do not paste real credentials into an AI conversation or commit this file.

The file schema is `morrow.lms-connections.v1`. Each connection has `id`, `label`, `provider`, `baseUrl`, and `token`. Blackboard also requires the `userId` returned with the same delegated OAuth token. The built-in connection listing omits tokens and does not claim that saved credentials remain valid.

Moodle calls `core_webservice_get_site_info` before each operation. It checks the site address, user ID, and included functions. The function list is not a substitute for Moodle's course permissions. Moodle installations under a URL subpath are supported. REST requests send the token in the POST body. `moodlewssettingraw=true` enables exact stored-text comparison.

Blackboard resolves the saved OAuth user UUID, then checks `/users/me/courses?limit=1&fields=userId` against that primary user ID. Empty, missing, or different identity evidence is refused. This first version therefore needs at least one readable current-user membership. It never substitutes another user's course list. Requests use bearer authentication. Token renewal is not yet implemented.

Before a write, Morrow reads the exact target again and compares its snapshot and connection hashes. It sends the write once. It then reads the item again and compares the requested and protected fields. Neither selected API provides an atomic edit lock for these operations. A network failure after send remains unconfirmed; it is not retried.

## Official API research

- [Moodle external-service setup](https://docs.moodle.org/502/en/Using_web_services) defines service functions, tokens, and user access.
- [Moodle external-function declarations](https://moodledev.io/docs/5.2/apis/subsystems/external/description) distinguish REST service inclusion from `ajax:true` browser access.
- [Moodle 5.2.2 course external API](https://github.com/moodle/moodle/blob/v5.2.2/public/course/externallib.php) defines course reads and updates.
- [Moodle call settings](https://github.com/moodle/moodle/blob/v5.2.2/public/webservice/lib.php) define raw output formatting.
- [Blackboard Learn 4000.21.0 schema](https://devportal-docstore.s3.amazonaws.com/learn-swagger-4000.21.0.json) defines the supported REST routes and permissions.
- [Blackboard current-user course mapping](https://blackboard.github.io/rest-apis/learn/advanced/soap-to-rest-mapping) documents `/users/me/courses`.
- [Blackboard content handlers](https://blackboard.github.io/rest-apis/learn/advanced/contenthandler-datatypes) distinguish Original content and Ultra document bodies.

Moodle also has a plugin-free signed-session path for specific AJAX-enabled operations. Course-state reads and supported section/activity renames are source-verified next candidates. They are not implemented by this REST checkpoint. Blackboard's documented token exchange requires application credentials; a public Chrome extension must not embed a vendor secret.

## Verification and remaining work

The full `pnpm test` run passed on September 4: 65 MCP-server tests, all other workspace tests, and 20 script tests. The tests use synthetic provider responses and synthetic sampling responses. They do not prove live tenant behavior or model judgment quality.

The independent code review produced five validated findings. All five are fixed: Moodle quiz passwords are removed before output; expired specialist responses and unsafe credential-file permissions have regression checks; chat results name the correct platform; large Blackboard documents retain approval names and verification. The large-document gateway test checks an existing body over 64,000 characters and an approved replacement over that limit, with one dispatch and no replay.

The full run also exposed repeated scanning in the existing privacy filter. A one-line change keeps the same sensitive-text checks and avoids retrying an email match at each character of an uninterrupted string. The focused two-platform approval test fell from 19.62 seconds to 170 milliseconds on this machine. The existing privacy tests pass. This is a local test measurement, not a live LMS latency claim.

The Canvas connector browser check passed in temporary Chrome for Testing. Its light, dark, and narrow approval screenshots were inspected. Separate in-app browser checks applied synthetic Moodle and Blackboard changes with one click and displayed confirmed results with the correct course and platform names. No real course was changed by these checks.

The broader launch still needs the educator-facing connection setup, live authorized Moodle and Blackboard tests, real client sampling, full Canvas/New Quizzes/Item Banks gates, learner access checks, packaging, and recorded demonstration. The active goal remains open.

## Post-deploy monitoring and validation

Owner: Morrow implementation controller. Window: each authorized test session before any launch claim.

Check saved operation states and `morrow_lms_connections` without logging credentials. Healthy: one dispatch followed by `verified` and correct provider readback. Failure: `applied_or_unknown`, missing identity, changed snapshots, or unintended protected-field changes. Stop that connection's writes, inspect the provider state, and correct through a new approved request. Never replay an uncertain request. A source revert must preserve the operation journal.
