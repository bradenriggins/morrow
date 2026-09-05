# Morrow

Move course work forward. Stay in control.

**Development preview:** Use this version only in a Canvas test course that you
have permission to change. Browser tests use a simulated Canvas site. Real
Canvas compatibility and full assistant testing are not yet complete. Some Item
Bank changes are disabled. See [current limits](LIMITATIONS.md).

Morrow helps course teams turn lesson and quiz requests into reviewed changes and checked results. Make the request through a compatible assistant, review the exact change in Morrow, and see what Canvas saved. You keep the teaching decisions.

Morrow runs on your computer and connects to an assistant through MCP. Source setup includes Codex, Claude Code, Claude desktop, and Gemini CLI. A selected Codex update has passed a live test-course check; each other assistant still needs its own complete live checks. See the [test record](docs/implementation/BT2-LIVE-PROOF.md).

## What a user installs

A user installs only two Morrow components:

1. **Morrow MCP** runs as one local stdio server. The selected chat application starts it when needed.
2. **Morrow Canvas Connector** is one Manifest V3 Chrome extension. It uses the Canvas session that is already signed in within Chrome.

No Canvas access token, developer key, OAuth app, ExamplePlatform service, legacy Morrow extension, hosted Morrow account, or separate approval application is required.

Node.js is the runtime for the current source release. It is part of the MCP installation path, not a third Morrow service.

## How a user works with Morrow

1. Add Morrow to your chosen assistant using the installation steps below. Open or restart that assistant.
2. Open the Morrow Canvas Connector extension in Chrome.
3. Select **Connect Morrow**. On the page that opens, select **Allow connection** if you started this request.
4. Open the Canvas test course you want to use in Chrome and sign in.
5. Open the extension again and select **Connect Canvas course**. Chrome asks for access to this Canvas site and, if open, its New Quizzes site.
6. Return to your assistant. Ask it to use Morrow to inspect or change the connected course.

The extension shows two separate states: whether Morrow is connected to your assistant, and whether you have saved a Canvas connection. It shows when Canvas was
last checked. A saved connection is not a promise that you are still signed in.
Morrow checks Canvas again before each request.

You continue working in your assistant. Morrow does not add another chat interface.
For example, ask it to list the modules in your connected test course or show
which assignments have no due date. Be specific about the course and what you
want to change.

Reading Canvas does not need a change approval. For a change, Morrow gives your
assistant a review link. Open it to see the courses, items, and requested values.
For a new quiz question, choose **Add this question** or **Cancel**. A group of
changes lists each request and uses **Apply all changes**, with the total count. Course and activity names
come from Canvas. If Morrow cannot identify them, approval stays unavailable until
the details load. Internal references stay in **Technical details**.

One click starts the approved work. The review shows progress and the checked
result automatically. You do not need to type “Continue.” Keep your assistant and
Chrome open while Morrow works. If the result is uncertain, ask Morrow in your
chat to check the existing request. Do not repeat the
change. To change your request before approval, cancel it and ask for a new one.

The review page is part of Morrow and runs on your computer. No separate review
app is installed. Morrow does not expose an AI tool that submits approval.

### See the content before you send it

The review renders proposed HTML as formatted content, not source code. Pages,
assignment instructions, discussions, and quiz instructions can show headings,
lists, tables, quotations, emphasis, and embedded image data. Long content flows
down the page. Short content does not leave an empty preview box.

For new multiple-choice, multiple-answer, and true/false questions with complete
supported answer settings, **Answer key** shows the choices, marked answers, and
feedback. **Try the question** lets you select an answer and see the supplied
feedback. This practice stays on your computer. It does not submit a student
attempt, approve the request, or send anything to Canvas. It compares your
selection with the proposed answer key; it does not establish that the key is
educationally correct or calculate a Canvas grade.

These previews use Morrow's layout, not Canvas's student player. Unsupported
question settings remain available below the preview. External images, videos,
and embedded tools are not fetched. Their placeholders remain visible. Links,
scripts, forms, and custom styles do not run inside the content. The exact
original request remains in **Technical details**. These display protections do
not rewrite the content sent to Canvas.

Large requests use a compact item list. Open an item for its full preview. Search
by title or course, or move through ten items at a time. Additions, edits, and
removals have separate labels. The approval button always shows the total number
of changes. Searching and opening previews do not change that total or exclude
items from approval. Removal warnings remain visible when a search hides the
affected item.

The local review starts the existing operation dispatcher after approval. Morrow checks the account, course, catalog, connection generation, target set, profile, approval, and effect receipt again. The connector sends the Canvas request once. It then performs a fresh provider readback. Morrow reports `verified` only when that readback satisfies the frozen postcondition. The result remains on the review page; automatic continuation inside a chat app is a separate, unverified client capability.

If delivery becomes ambiguous, Morrow records `applied_or_unknown` and refuses automatic replay. A later reconciliation performs only the frozen readback.

## Use Morrow with your other tools

You can ask for an outcome that uses more than your learning platform. For
example: “Create a PDF study guide from Week 4 and send it to Michelle Bradley
with a message in my voice.”

Morrow reads the course materials. Your assistant then coordinates its installed
document, PDF, contacts, and email tools. The workflow keeps the source titles
and links, checks the completed file, uses your approved writing preferences,
resolves the correct recipient, and checks the send result. It must identify
missing sources or tools instead of silently skipping them.

Morrow provides these instructions to the assistant when it connects. The assistant
decides which tools and skills to use. This is guidance, not a guarantee that
every assistant will trigger every installed skill. Morrow does not install a second
document editor, access another plugin's credentials, or use course-change
approval to authorize email. End-to-end compatibility requires testing in the
chosen assistant with its actual tools. That cross-plugin workflow is not yet a
verified Morrow release claim.

## Check a New Quiz

Ask your assistant: “Use Morrow to check the Week 3 quiz. It should have 20
questions worth 20 question points. Check for repeated question content in the
Week 2 quiz too.” Your assistant resolves the named course and quizzes, then calls
`morrow_check_new_quiz` with those exact targets.

The report names the course and quizzes. It checks the number of directly listed
questions, their total points, saved choice-based answer settings, and repeated
question content. It can compare up to three other New Quizzes in the same
course. Reads use the existing Chrome connection. No change approval is needed.

This is a structural check, not a complete assessment review. Repeated content
means identical question content apart from extra whitespace, not similar ideas.
The check does not judge answer correctness, learning objectives, accessibility,
bank contents, or student access. Partial reads and bank draws are marked
incomplete. Question points are not the same as Canvas assignment gradebook points.

This workflow has automated connector tests. Live Canvas verification is still
required before treating it as a production-ready feature.

## Review a lesson against your source

Ask: “Compare the Cell Structure lesson and quiz with this revised source.
Show the conflicts and proposed corrections. Do not change the course yet.”

Morrow can request separate lesson and quiz reviews from your assistant. It then
requests a third check of the findings. The report includes exact source quotes,
proposed corrections, disagreements, and limits. You review the proposals before
requesting any changes. Morrow does not make changes during this review.

This feature requires an assistant that supports MCP sampling. It currently covers
one Canvas page and up to 40 directly saved choice, multiple-answer, or true/false
New Quiz questions. It does not review bank draws, essays, media, accessibility,
or student access. Automated tests cover the model-request flow; real client and
model testing is still required.

## Private Moodle and Blackboard preview

Moodle and Blackboard are private, hand-configured API previews. They do not
use the Chrome Canvas session. They are not OAuth onboarding, and they are not
ready for general users.

| Provider | Connection and first validation | Private-preview scope | Not included |
| --- | --- | --- | --- |
| Moodle | HTTPS REST service token. Each call checks the returned site URL, user ID, and enabled service functions. | Five reads: my courses, one course, contents, assignment settings, and quiz settings. One change: course-summary replacement. Moodle requests use raw stored-text output for comparison. | General activity or question authoring, browser-session transport, and live-tenant compatibility proof. |
| Blackboard | HTTPS API base URL, delegated bearer token, and the UUID returned for the same delegated user. Each call resolves that UUID and checks one current-user membership. | Five reads: my courses, one course, top-level content, direct content children, and one content item. One change: title and/or body of a verified `resource/x-bb-document`. | OAuth registration, token renewal, recursive inventory, assessment or bank authoring, and live-tenant compatibility proof. |

For a Blackboard Ultra document body, first use
`blackboard_list_content_children` on the page wrapper that Blackboard identifies
as `resource/x-bb-folder`. It reads that exact parent, returns one direct page
with `recursive=false`, and explicitly includes the Ultra body. Only a returned
`resource/x-bb-document` child is eligible for a document update. See the
[implementation checkpoint](docs/implementation/MULTI-LMS-AND-LESSON-REVIEW.md).

### Connect a private preview

Create the private `~/.morrow/lms-connections.json` file. On macOS or Linux,
the directory must be owner-only and the file must be mode `0600`:

```bash
mkdir -p ~/.morrow
chmod 700 ~/.morrow
(umask 077; touch ~/.morrow/lms-connections.json)
chmod 600 ~/.morrow/lms-connections.json
```

For a new file, open it in a local editor and use the template below. For an
existing file, add only the needed connection objects to its `connections` array.
Replace the placeholders with real values in that local file. Remove connections
you do not use. Do not send this file to an AI client or commit it.
Moodle may use an HTTPS subpath. Blackboard must use the HTTPS site root, and
its `userId` is the delegated OAuth user UUID for the same token.

```json
{
  "schema": "morrow.lms-connections.v1",
  "connections": [
    {
      "id": "moodle-preview",
      "label": "Moodle private preview",
      "provider": "moodle",
      "baseUrl": "https://moodle.example.edu/moodle",
      "token": "REPLACE_WITH_MOODLE_SERVICE_TOKEN"
    },
    {
      "id": "blackboard-preview",
      "label": "Blackboard private preview",
      "provider": "blackboard",
      "baseUrl": "https://learn.example.edu",
      "token": "REPLACE_WITH_DELEGATED_BEARER_TOKEN",
      "userId": "00000000-0000-0000-0000-000000000000"
    }
  ]
}
```

The Moodle service must expose `core_webservice_get_site_info` and the functions
for the chosen operation. `core_enrol_get_users_courses` and
`core_course_get_courses` support the first reads. Add
`core_course_get_contents`, `mod_assign_get_assignments`,
`mod_quiz_get_quizzes_by_courses`, or `core_course_update_courses` only when
their matching tool is required. Function presence does not grant course
permission. Moodle sends `moodlewssettingraw=true`, so the course-summary
readback compares the stored summary exactly.

Restart the selected AI client after saving the file. First call
`morrow_lms_connections`; it lists only ID, label, provider, and base URL, and
does not prove access. Then make one exact read:

```json
{ "connection_id": "moodle-preview", "course_id": 12345 }
```

Use that object with `moodle_get_course`. For Blackboard, use this object with
`blackboard_get_course`:

```json
{ "connection_id": "blackboard-preview", "course_id": "_123_1" }
```

Fresh `pnpm run setup` writes the `lms-api` source automatically. An existing
custom `morrow.upstreams.json` is not replaced. Add this object to its
`upstreams` array, preserving the current entries and absolute paths:

```json
{
  "id": "lms-api",
  "label": "Moodle and Blackboard",
  "kind": "mcp-stdio",
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/morrow/packages/mcp-server/dist/lms-api-entry.js"],
  "cwd": "/absolute/path/to/morrow",
  "sourceDisposition": "direct_owned",
  "priority": 150,
  "required": true,
  "outputPrivacyDefault": {
    "fieldPolicy": "scrub-sensitive",
    "dataClass": "course",
    "maxRecords": 10000,
    "maxBytes": 2000000,
    "freeText": "allow",
    "learnerTokens": true,
    "artifactInspection": "deny"
  }
}
```

The `lms-api` source reads this file when the client starts, unless the launcher
sets `MORROW_LMS_CONNECTIONS_FILE` to another private path. It has no real token
exchange, refresh, or OAuth registration flow. The
[implementation checkpoint](docs/implementation/MULTI-LMS-AND-LESSON-REVIEW.md)
lists the official API basis, adapter evidence, and remaining limits.

## Canvas authentication

Canvas authentication stays inside Chrome.

- The extension requests access to the selected Canvas site and any supported New Quizzes site open inside that tab. Chrome lists the requested sites before access is granted.
- Normal Canvas API requests use the page's signed-in session and Canvas CSRF protection.
- New Quizzes Item Bank requests run inside the authenticated New Quizzes frame. Frame tokens remain in the page execution world. The extension never returns them to the MCP or AI client.
- The MCP receives a bounded account fingerprint and connection generation. It does not receive cookies, passwords, OAuth tokens, CSRF tokens, or Item Bank bearer tokens.
- **Disconnect Morrow** clears the saved Morrow connection and requests removal of its Canvas site permissions. If Chrome cannot remove those permissions, the extension explains that they still need removal in Chrome settings. Disconnecting does not sign you out of Canvas or undo changes already sent.

Morrow does not reuse a ChatGPT or Claude in-app browser session. Configured assistants use the Chrome connector for Canvas. The selected Codex workflow has a live test record; other assistants still need complete live checks.

## Capability surface

The generated catalog currently describes 1,130 Canvas operations. A catalog entry is not proof of live compatibility:

- 1,118 operations generated from the current official Canvas API definitions;
- 568 reads and 562 writes;
- 26 New Quizzes operations;
- 12 signed-browser New Quizzes Item Bank operations.

The surface includes course and account discovery, pages, modules, assignments, groups, discussions, announcements, files, folders, Classic Quizzes, New Quizzes, Item Banks, rubrics, outcomes, enrollments, submissions, gradebook operations, migrations, Blueprints, reports, webhooks, and other official Canvas families.

The Item Bank bridge implements request contracts for:

- list, get, create, share, and archive banks;
- list and get entries;
- create and update items;
- attach an item to a bank;
- delete an entry;
- list bank shares.

Existing-bank writes are currently held: archive, share, attach, create item, update item, and delete entry. These operations can affect other courses and quizzes. They cannot dispatch until Morrow can establish a complete dependency and affected-course review. Bank reads and bank creation remain enabled. Live Item Bank compatibility is not yet verified.

Morrow keeps 64-bit Canvas identifiers as exact decimal strings. It generates tool schemas and routes from provider definitions. It rejects unknown fields, missing required values, cross-origin bindings, stale tabs, stale connection generations, mismatched operation keys, and expired commands before provider dispatch.

MindTap and Connect are absent from the enabled catalog and runtime.

## Batches and long-running work

Morrow supports durable read and write batches across explicit course sets.

- Every child has an exact course, tool, arguments digest, source binding, dependency set, and operation ID.
- One local page shows the complete frozen target set before approval.
- One click starts the approved write batch through bounded windows. The review updates its confirmed count. It stops starting more work after an unconfirmed result. **Stop remaining changes** cancels unsent operations; a request already sent can still finish.
- Each write child receives its own single-use effect receipt.
- Approved concurrency and rate controls cannot change during execution.
- Child results remain independently true when another child fails or becomes uncertain.
- Pause and cancel stop new child dispatch.
- Restart recovery resumes from durable checkpoints and never replays an uncertain write.
- Large batches use bounded database pages instead of one unbounded MCP response.

## Privacy and local state

Morrow projects results before it returns them to the AI client. It applies field policy, record limits, byte limits, free-text policy, and learner tokenization at the gateway boundary. Sensitive nested errors are scrubbed. The learner vault, operation journal, encrypted batch manifests, pairing state, and verification receipts stay on the user's computer.

Client configuration contains only the local Node command, server entry path, working directory, and `MORROW_UPSTREAMS_FILE`. It contains no Canvas credential or browser secret.

## Install from this repository

Requirements:

- Node.js 22.13 or newer;
- pnpm 10.6.1 through Corepack;
- Chrome 116 or newer;
- one MCP-compatible client.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run setup
```

`pnpm run setup` builds the workspace and writes a private local `morrow.upstreams.json` with absolute paths. It prints the unpacked extension directory.

This preview is not installed from the Chrome Web Store. Open
`chrome://extensions`, turn on **Developer mode**, select **Load unpacked**, and
choose the `connector/extension` folder. Your organization must allow this.
If managed Chrome blocks Developer mode or this extension, this preview cannot
connect through that browser. Do not bypass your organization's restrictions.

To build a ZIP of the extension:

```bash
pnpm package:connector
```

Extract `artifacts/connector/morrow-canvas-connector-v1.0.1.zip`. Use **Load
unpacked** to select the extracted folder that contains `manifest.json`, not the
ZIP file. Keep that folder in place while the extension is installed.

Bridge 1.0.1 adds checked page-text changes. Update the local MCP and bridge together, then reconnect them. An older bridge cannot run this workflow.

Configure Morrow in any of these clients. This release supports one active client runtime per local installation; it does not yet share one running bridge across simultaneous clients:

```bash
pnpm morrow mcp install codex --scope project --upstreams "$PWD/morrow.upstreams.json"
pnpm morrow mcp install claude --scope project --upstreams "$PWD/morrow.upstreams.json"
pnpm morrow mcp install claude-desktop --scope user --upstreams "$PWD/morrow.upstreams.json"
pnpm morrow mcp install gemini --scope project --upstreams "$PWD/morrow.upstreams.json"
```

The aliases `claude` and `gemini` select Claude Code and Gemini CLI. Claude desktop chat supports user scope on macOS and Windows.

The generated client files are:

- Codex or ChatGPT/Codex desktop: `.codex/config.toml`;
- Claude Code: `.mcp.json` or `~/.claude.json`;
- Claude desktop chat: `claude_desktop_config.json`;
- Gemini CLI: `.gemini/settings.json`.

Restart the selected client after configuration. The client then starts Morrow over stdio. The Morrow MCP starts its internal Canvas connector runtime. The Chrome extension connects to that runtime at `127.0.0.1:32147`.

For Codex write requests, use the interactive client so you can answer its tool-approval prompt. **Allow** lets Codex prepare the Morrow request. Review and approve the exact change in Morrow before it is sent to the LMS. With write approval enabled, noninteractive `codex exec` cannot answer that prompt and can cancel the call before it reaches Morrow.

## Native Morrow tools

Use these tools to inspect and control the layer:

- `morrow_health` reports the profile, catalog, local operation journal, batch ledger, connector process, and current browser connection.
- `morrow_catalog`, `morrow_catalog_search`, and `morrow_capability_get` provide bounded discovery across the full surface.
- `morrow_canvas_connector_health` reports the local connector transport.
- `morrow_canvas_bindings` lists bounded, non-secret Canvas session bindings.
- `morrow_plan_page_correction` prepares one exact text change on a Canvas page. The review shows the course, page, current text, and replacement. The bridge preserves the surrounding page and checks the saved page and its revision history.
- `morrow_operation_*` tools inspect, dispatch, cancel, reconcile, verify, and create separate corrective operations.
- `morrow_batch_*` tools create, inspect, run, pause, recover, reconcile, cancel, and page durable batches.
- `morrow_result_page` retrieves bounded pages for large local results.

Provider operations use generated `canvas_*` names. A call to a read tool executes. A call to a write tool creates a plan.

For example, ask your assistant: “On the Cell structure page in Introduction to Human Biology, change ‘Cells have membranes.’ to ‘Cells have protective membranes.’ Keep everything else.” Morrow reads the current page before it creates the review. **Change this text** starts the work and shows the result on that page. It checks for newer edits before sending. It reports a checked result only when the saved page and one new revision match the approved change.

This page workflow changes a unique phrase within one text section. It does not support block-editor pages, text split across HTML tags, or an automatic undo. Canvas does not lock the page during these checks. Avoid editing it until the result is checked. A selected live Canvas test confirmed the exact phrase change and unchanged page settings. A stale proposal failed before send, and a fresh read confirmed no later effect. See the [BT2 proof record](docs/implementation/BT2-LIVE-PROOF.md) for the tested scope.

## Verification

Run the complete local campaign:

```bash
pnpm catalog:export
pnpm catalog:merge
pnpm catalog:check
pnpm build
pnpm test
pnpm test:connector
pnpm test:package
pnpm package:connector
pnpm package:connector:check
pnpm morrow doctor --json
pnpm morrow catalog stats --json
```

The browser campaign uses Chrome for Testing with a temporary profile and a synthetic Canvas estate. It validates extension pairing, site-scoped permission, account binding, regular Canvas reads and writes, a complete nested New Quiz item request, cookies and CSRF handling, fresh readback, replay refusal, restart, and disconnect revocation.

See [ARCHITECTURE.md](ARCHITECTURE.md), [WEEKEND-HANDOFF.md](WEEKEND-HANDOFF.md), [LIMITATIONS.md](LIMITATIONS.md), and [SOURCE-ORIGIN.md](SOURCE-ORIGIN.md).

## Release status

The repository uses `1.0.0-rc.0`. Local private and public-candidate archives are deterministic and include checksums, a stage manifest, and a CycloneDX SBOM. A public stable tag still requires the documented source-rights, provider-policy, independent reproduction, and publication approvals. These distribution gates do not change the local runtime architecture.
