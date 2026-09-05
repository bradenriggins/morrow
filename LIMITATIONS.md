# Limitations

Morrow `1.0.0-rc.0` is a local release candidate. It is not yet a stable public release or an Instructure authorization claim.

## Current external gates

- The automated browser campaign uses a synthetic Canvas estate. Separate authorized [BT2 tests](docs/implementation/BT2-LIVE-PROOF.md) record selected live lesson, quiz, module, learner, page-create, and native Codex update results. They do not prove the full Canvas catalog or live Item Bank compatibility.
- Client configuration parity is tested for ChatGPT/Codex, Claude Code, Claude desktop chat, and Gemini CLI. Each available real client still needs the complete live scenario before a cross-client production claim.
- An independent clean-machine reproduction has not completed.
- Public source-rights review and explicit publication authorization are separate release gates.
- A Chrome Web Store listing is not part of this repository. The current extension installs unpacked from source or from a locally built deterministic archive.

## Product limits

- Canvas uses the signed-in Chrome connector. Moodle and Blackboard have separate, private, hand-configured API previews with five reads and one bounded write each. Their official API and local test evidence does not establish live-tenant compatibility. See [provider scope](README.md#private-moodle-and-blackboard-preview).
- MindTap and Connect are not supported, listed, or callable.
- The connector can act only with the permissions of the current signed-in Canvas user.
- The connector needs an open, signed-in Canvas tab. Item Bank operations also need an authenticated New Quizzes frame for the selected tenant and course.
- Six existing-bank mutation contracts are held pending complete dependency and affected-course evidence. Bank reads and creation remain enabled. A matching request contract does not establish safe cross-course effects.
- The connector does not reuse authentication from ChatGPT, Claude, or another application's in-app browser.
- Chrome grants optional site access per Canvas origin. A school that blocks extensions, frame execution, local WebSockets, or Canvas API access can prevent operation.
- Content Security Policy or a future Canvas UI change can require a connector update. Catalog and browser tests detect known contract drift, but they cannot prevent provider changes.
- Only exact explicit course sets can create write batches. Morrow does not treat partial discovery as an all-courses target.
- A write without a safe frozen readback route is refused or remains unconfirmed. It is never reported as verified.
- Undo is a new correction operation. Morrow does not pretend that every Canvas action has a lossless inverse.
- Checked page-text changes require bridge 1.0.1 and the matching local MCP. They replace one unique phrase in a complete, unfiltered rich-text page. They do not support block-editor pages, phrases split across HTML tags, or automatic undo. A fresh page and revision check detects stale reviews, but Canvas supplies no documented atomic edit lock for this request. Concurrent edits can still make the result unconfirmed.
- A provider timeout or lost response after send can become `applied_or_unknown`. Morrow does not replay it.
- Large read results use bounded process-local handles. These handles do not survive a gateway restart.
- Durable operation and batch state is local to one Morrow installation. It is not a hosted synchronization service.
- Multiple clients can be configured, but only one can run the installation at a time. The Chrome bridge uses one local port. A second runtime reports the conflict and does not replace the existing bridge.
- Morrow does not bypass Canvas role, course, account, New Quizzes, or Item Bank permissions.

## Security boundary

The browser connector prevents credentials from entering MCP messages, client configuration, logs, or durable operation records. It does not protect a computer that is already compromised, a malicious Chrome extension with broader access, or a malicious local process running as the same operating-system user.

The local approval page requires a separate decision outside the MCP tool surface. It checks the local origin, page nonce, and browser cookie. It cannot prove human presence against software with local HTTP or browser control. It is not multi-person institutional approval.

## Release behavior

`pnpm package:connector` creates deterministic extension bytes and a SHA-256 receipt. `pnpm package:rc` creates deterministic private and public local candidate archives with a stage manifest, checksums, and CycloneDX SBOM.

Package creation does not publish software. Stable `1.0.0`, a registry release, a Chrome Web Store release, or public provider claims require explicit release authorization and current receipts.
