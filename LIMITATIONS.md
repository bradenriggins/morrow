# Limitations

Morrow `1.0.0-rc.0` is a local release candidate. It is not yet a stable public release or an Instructure authorization claim.

## Current external gates

- The automated browser campaign uses a synthetic Canvas estate. Authorized live Canvas proof must still record the exact tenant, test account, operations, readbacks, and cleanup.
- Client configuration parity is tested for ChatGPT/Codex, Claude Code, Claude desktop chat, and Gemini CLI. Each available real client still needs the complete live scenario before a cross-client production claim.
- An independent clean-machine reproduction has not completed.
- Public source-rights review and explicit publication authorization are separate release gates.
- A Chrome Web Store listing is not part of this repository. The current extension installs unpacked from source or from a locally built deterministic archive.

## Product limits

- Canvas is the only enabled LMS provider.
- MindTap and Connect are not supported, listed, or callable.
- The connector can act only with the permissions of the current signed-in Canvas user.
- The connector needs an open, signed-in Canvas tab. Item Bank operations also need an authenticated New Quizzes frame for the selected tenant and course.
- The connector does not reuse authentication from ChatGPT, Claude, or another application's in-app browser.
- Chrome grants optional site access per Canvas origin. A school that blocks extensions, frame execution, local WebSockets, or Canvas API access can prevent operation.
- Content Security Policy or a future Canvas UI change can require a connector update. Catalog and browser tests detect known contract drift, but they cannot prevent provider changes.
- Only exact explicit course sets can create write batches. Morrow does not treat partial discovery as an all-courses target.
- A write without a safe frozen readback route is refused or remains unconfirmed. It is never reported as verified.
- Undo is a new correction operation. Morrow does not pretend that every Canvas action has a lossless inverse.
- A provider timeout or lost response after send can become `applied_or_unknown`. Morrow does not replay it.
- Large read results use bounded process-local handles. These handles do not survive a gateway restart.
- Durable operation and batch state is local to one Morrow installation. It is not a hosted synchronization service.
- Morrow does not bypass Canvas role, course, account, New Quizzes, or Item Bank permissions.

## Security boundary

The browser connector prevents credentials from entering MCP messages, client configuration, logs, or durable operation records. It does not protect a computer that is already compromised, a malicious Chrome extension with broader access, or a malicious local process running as the same operating-system user.

The local approval page proves a separate human action at the Morrow loopback boundary. It is not multi-person institutional approval. Institutions can add their own policy outside Morrow.

## Release behavior

`pnpm package:connector` creates deterministic extension bytes and a SHA-256 receipt. `pnpm package:rc` creates deterministic private and public local candidate archives with a stage manifest, checksums, and CycloneDX SBOM.

Package creation does not publish software. Stable `1.0.0`, a registry release, a Chrome Web Store release, or public provider claims require explicit release authorization and current receipts.
