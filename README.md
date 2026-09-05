# Morrow

Work in Canvas from your AI conversation.

**Development preview:** Use this version only in a Canvas test course that you
have permission to change. Browser tests use a simulated Canvas site. Real
Canvas compatibility and full AI-app testing are not yet complete. Some Item
Bank changes are disabled. See [current limits](LIMITATIONS.md).

Morrow is a local, chat-interface-agnostic Canvas operations layer. It gives MCP-compatible AI clients one governed tool surface for Canvas. The AI client supplies intent and calls tools. Morrow owns connection, authority, approval, dispatch, verification, durable state, privacy, and evidence.

Morrow has no chat interface. Use it from ChatGPT/Codex, Claude Code, the Claude desktop app, Gemini CLI, or another stdio MCP client.

## What a user installs

A user installs only two Morrow components:

1. **Morrow MCP** runs as one local stdio server. The selected chat application starts it when needed.
2. **Morrow Canvas Connector** is one Manifest V3 Chrome extension. It uses the Canvas session that is already signed in within Chrome.

No Canvas access token, developer key, OAuth app, ExamplePlatform service, legacy Morrow extension, hosted Morrow account, or separate approval application is required.

Node.js is the runtime for the current source release. It is part of the MCP installation path, not a third Morrow service.

## How a user works with Morrow

1. Add Morrow to your chosen AI app using the installation steps below. Open or restart that app.
2. Open the Morrow Canvas Connector extension in Chrome.
3. Select **Connect Morrow**. On the page that opens, select **Allow connection** if you started this request.
4. Open the Canvas test course you want to use in Chrome and sign in.
5. Open the extension again and select **Connect Canvas course**. Chrome asks for access to this Canvas site and, if open, its New Quizzes site.
6. Return to your AI conversation. Ask it to use Morrow to inspect or change the connected course.

The extension shows two separate states: whether Morrow is connected to your AI
app, and whether you have saved a Canvas connection. It shows when Canvas was
last checked. A saved connection is not a promise that you are still signed in.
Morrow checks Canvas again before each request.

You continue working in your AI app. Morrow does not add another chat interface.
For example, ask it to list the modules in your connected test course or show
which assignments have no due date. Be specific about the course and what you
want to change.

Reading Canvas does not need a change approval. For a change, Morrow gives your
AI app a review link. Open it to see the courses, items, and requested values.
For a new quiz question, choose **Add this question** or **Cancel**. A group of
changes lists each request and uses **Apply these changes**. Course and activity names
come from Canvas. If Morrow cannot identify them, approval stays unavailable until
the details load. Internal references stay in **Technical details**.

One click starts the approved work. The review shows progress and the checked
result automatically. You do not need to type “Continue.” Keep your AI app and
Chrome open while Morrow works. If the result is uncertain, ask Morrow in your
chat to check the existing request. Do not repeat the
change. To change your request before approval, cancel it and ask for a new one.

The review page is part of Morrow and runs on your computer. No separate review
app is installed. Morrow does not expose an AI tool that submits approval.

The local review starts the existing operation dispatcher after approval. Morrow checks the account, course, catalog, connection generation, target set, profile, approval, and effect receipt again. The connector sends the Canvas request once. It then performs a fresh provider readback. Morrow reports `verified` only when that readback satisfies the frozen postcondition. The result remains on the review page; automatic continuation inside a chat app is a separate, unverified client capability.

If delivery becomes ambiguous, Morrow records `applied_or_unknown` and refuses automatic replay. A later reconciliation performs only the frozen readback.

## Check a New Quiz

Ask your AI app: “Use Morrow to check the Week 3 quiz. It should have 20
questions worth 20 question points. Check for repeated question content in the
Week 2 quiz too.” Your AI app resolves the named course and quizzes, then calls
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

Morrow can request separate lesson and quiz reviews from your AI app. It then
requests a third check of the findings. The report includes exact source quotes,
proposed corrections, disagreements, and limits. You review the proposals before
requesting any changes. Morrow does not make changes during this review.

This feature requires an AI app that supports MCP sampling. It currently covers
one Canvas page and up to 40 directly saved choice, multiple-answer, or true/false
New Quiz questions. It does not review bank draws, essays, media, accessibility,
or student access. Automated tests cover the model-request flow; real client and
model testing is still required.

## Moodle and Blackboard development preview

The private/full installation also contains Moodle and Blackboard support.
There is no extra Morrow app to install.

- **Moodle:** Read courses, activities, assignment settings, and quiz settings.
  Review and apply a course-description change.
- **Blackboard:** Read courses and content. Review and apply a supported
  document's title or body change.

These connections use private, locally saved API credentials. They do not use
the Chrome session. Their connection setup is not yet ready for general users.
Tests currently use simulated platforms. Full quiz and question-bank authoring
and live school-account tests remain open. See the
[implementation checkpoint](docs/implementation/MULTI-LMS-AND-LESSON-REVIEW.md).

## Canvas authentication

Canvas authentication stays inside Chrome.

- The extension requests access to the selected Canvas site and any supported New Quizzes site open inside that tab. Chrome lists the requested sites before access is granted.
- Normal Canvas API requests use the page's signed-in session and Canvas CSRF protection.
- New Quizzes Item Bank requests run inside the authenticated New Quizzes frame. Frame tokens remain in the page execution world. The extension never returns them to the MCP or AI client.
- The MCP receives a bounded account fingerprint and connection generation. It does not receive cookies, passwords, OAuth tokens, CSRF tokens, or Item Bank bearer tokens.
- **Disconnect Morrow** clears the saved Morrow connection and requests removal of its Canvas site permissions. If Chrome cannot remove those permissions, the extension explains that they still need removal in Chrome settings. Disconnecting does not sign you out of Canvas or undo changes already sent.

Morrow does not reuse a ChatGPT or Claude in-app browser session. The Chrome connector is the stable provider boundary for every supported chat client.

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

For example, ask your AI: “On the Cell structure page in Introduction to Human Biology, change ‘Cells have membranes.’ to ‘Cells have protective membranes.’ Keep everything else.” Morrow reads the current page before it creates the review. **Change this text** starts the work and shows the result on that page. It checks for newer edits before sending. It reports a checked result only when the saved page and one new revision match the approved change.

This page workflow changes a unique phrase within one text section. It does not support block-editor pages, text split across HTML tags, or an automatic undo. Canvas does not lock the page during these checks. Avoid editing it until the result is checked. Live Canvas verification of this workflow remains outstanding.

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
