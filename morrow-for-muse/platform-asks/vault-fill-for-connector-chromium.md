# Platform ask: Secure Vault fill targeting connector-managed Chromium

Status: DRAFT, not filed. Needs Braden's go-ahead before filing via the Muse feedback channel.

## Who is asking

Connector developer building Morrow for Muse (LMS bridge: Canvas/Moodle), intended for submission to Meta. The no-PAT auth lane is the core requirement: many educators' institutions forbid minting Canvas API tokens, so the connector must act through an authenticated browser session and the Canvas REST API, with zero UI automation after login.

## What exists today

Secure Vault + `credentials.request_login` + per-use approved `credential_fill` into the **managed browser task**. The agent never sees the value. This is the right primitive and it works.

## What is missing

A fill **destination** for Chromium managed by the connector on the Muse agent VM (CDP-driven, e.g. platform-mediated `Input.insertText` into the connector's browser), with the credential value never transiting the agent.

## Why it is needed

We proved connector-controlled Chromium on the VM can do everything the product needs (page-context `fetch()` against the Canvas API on an authenticated session, verified end to end). What we cannot do product-grade is the **first login**:

- "Paste your password into chat" can never be a shipped onboarding. It is the exact sentence the Secure Vault exists to prevent.
- Lifting session cookies out of the managed browser is silent bearer-token exfiltration through the agent's context. Worse, not better.
- The managed browser cannot carry the write path itself: it has no script execution, and `data:` URL navigation is blocked at the automation layer as a deliberate CSRF-vector guard (verified by direct probe 2026-09-20). So the session must live in the connector's Chromium.

The missing primitive is small and mirrors the existing one: same secure card, same per-use user approval, same never-touches-the-agent guarantee, aimed at a CDP session the connector owns instead of the managed browser task.

## Related ask (already logged)

Allow `data:` URL navigation in browser-task `goto` (data: pages already render in the managed browser's Chromium; only the bootstrap is missing). Tracked separately; this vault-fill ask stands on its own.

## What we will do once it exists

Educator connects Canvas: Morrow launches its VM Chromium at the Canvas login, the platform fills the vault credential with explicit per-approval, the educator completes MFA on their own device, the persistent profile holds the session. Pure API after that. No password in chat, no cookies in agent context, no UI automation.
