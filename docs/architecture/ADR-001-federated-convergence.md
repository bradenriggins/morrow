# ADR-001: Standalone Canvas operations layer

- Status: accepted
- Date: 2026-09-04
- Owners: Braden Riggins and the Morrow maintainers

## Decision

Morrow will ship as one standalone local MCP server with one directly owned Chrome session connector.

The external server uses the official TypeScript MCP SDK. It generates its Canvas catalog from current provider definitions and an explicit Item Bank contract. It owns the operation journal, approval service, effect broker, batch engine, privacy boundary, result envelope, client configuration, and evidence.

The runtime has no dependency on legacy Morrow, ExamplePlatform, their extensions, their user interfaces, their repositories, or an SSH service.

## Reasons

1. Users need the same operations layer from any MCP-compatible chat interface.
2. Most Canvas users cannot obtain an institution-wide OAuth developer key.
3. A signed-in Chrome session is available to the user and can enforce the user's existing Canvas permissions.
4. Browser-session transport supports regular Canvas APIs and authenticated New Quizzes Item Bank frames without exporting credentials.
5. One direct execution path removes double approval, donor drift, private deployment requirements, and ambiguous ownership.
6. Durable plan, approval, effect, verification, batch, privacy, and failure contracts remain useful independent of their earlier implementations.

## Runtime rules

- One stdio MCP endpoint serves every supported client.
- The connector is the only Canvas transport in the default profile.
- The catalog is generated and digest-bound.
- Each row has an explicit profile, authority, privacy, route, and verification disposition.
- Reads execute only through a current runtime-verified binding.
- Writes plan first and require separate local approval.
- MCP exposes no operation-approval tool. Approval uses a separate local browser page. This prevents approval through the MCP surface; it does not prove human presence against software with local HTTP or browser control.
- Each approved effect can dispatch once.
- Provider readback, not dispatch response, determines verified success.
- Ambiguous writes are never replayed automatically.
- Batches retain child-level truth across pause, failure, uncertainty, and restart.
- Credentials and browser tokens never cross the connector boundary.
- MindTap and Connect are not registered or callable.

## Consequences

A user installs Morrow MCP and the Morrow Canvas Connector. The user can then use Morrow from ChatGPT/Codex, Claude, Gemini, or another compatible client without changing Canvas authentication.

The source tree may retain historical comparison fixtures until removal is safe. They are not part of the default runtime or public Canvas package. No product claim depends on them.

A stable public release still requires source-rights review, provider-policy review, independent reproduction, and explicit publication authorization. These are distribution gates, not runtime dependencies.
