# Morrow

Models reason. Morrow safely operates Canvas.

Morrow is a local, chat-interface-agnostic Canvas operations layer. It gives MCP-compatible AI clients one governed tool surface for Canvas. The AI client supplies intent and calls tools. Morrow owns connection, authority, approval, dispatch, verification, durable state, privacy, and evidence.

Morrow has no chat interface. Use it from ChatGPT/Codex, Claude Code, the Claude desktop app, Gemini CLI, or another stdio MCP client.

## What a user installs

A user installs only two Morrow components:

1. **Morrow MCP** runs as one local stdio server. The selected chat application starts it when needed.
2. **Morrow Canvas Connector** is one Manifest V3 Chrome extension. It uses the Canvas session that is already signed in within Chrome.

No Canvas access token, developer key, OAuth app, ExamplePlatform service, legacy Morrow extension, hosted Morrow account, or separate approval application is required.

Node.js is the runtime for the current source release. It is part of the MCP installation path, not a third Morrow service.

## How a user works with Morrow

1. Start or install the Morrow MCP in the chosen AI client.
2. Open the Morrow Canvas Connector popup.
3. Select **Connect to Morrow MCP**.
4. Review the local pairing page that opens at `127.0.0.1`. Approve that one extension pairing.
5. Open the exact signed-in Canvas course in Chrome.
6. Select **Connect this Canvas tab** in the extension.
7. Ask the AI client to inspect or change Canvas.

Read operations run against the selected Chrome session. Write operations do not run immediately. Morrow first returns a frozen plan and a local approval URL. The user opens that URL, reviews the exact tool, account, course, fields, target digest, risk, expiry, and verification method, and selects **Approve once** or **Cancel**. There is no model-callable approval tool.

After approval, the AI client calls `morrow_operation_dispatch` with the operation ID. Morrow checks the account, course, catalog, connection generation, target set, profile, approval, and effect receipt again. The connector sends the Canvas request once. It then performs a fresh provider readback. Morrow reports `verified` only when that readback satisfies the frozen postcondition.

If delivery becomes ambiguous, Morrow records `applied_or_unknown` and refuses automatic replay. A later reconciliation performs only the frozen readback.

## Canvas authentication

Canvas authentication stays inside Chrome.

- The extension requests access to the exact Canvas site only after the user selects a signed-in tab.
- Normal Canvas API requests use the page's signed-in session and Canvas CSRF protection.
- New Quizzes Item Bank requests run inside the authenticated New Quizzes frame. Frame tokens remain in the page execution world. The extension never returns them to the MCP or AI client.
- The MCP receives a bounded account fingerprint and connection generation. It does not receive cookies, passwords, OAuth tokens, CSRF tokens, or Item Bank bearer tokens.
- **Disconnect and revoke access** clears the local pairing secret, Canvas bindings, used effect receipts, and optional Canvas site permissions.

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

Load `connector/extension` from `chrome://extensions` with **Developer mode** and **Load unpacked**. A deterministic distributable archive is also available after:

```bash
pnpm package:connector
```

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
- `morrow_operation_*` tools inspect, dispatch, cancel, reconcile, verify, and create separate corrective operations.
- `morrow_batch_*` tools create, inspect, run, pause, recover, reconcile, cancel, and page durable batches.
- `morrow_result_page` retrieves bounded pages for large local results.

Provider operations use generated `canvas_*` names. A call to a read tool executes. A call to a write tool creates a plan.

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
