# ADR-001: Assemble Morrow as a federation gateway before extraction

- Status: accepted for the first implementation branch
- Date: 2026-09-03
- Owners: Braden Riggins and the Morrow maintainers

## Decision

The new Morrow repository begins as an external MCP gateway over existing donor runtimes rather than a rewrite of their capability implementations.

The gateway uses the official TypeScript MCP SDK. Meridian runs as an internal stdio MCP upstream. The existing Morrow capability catalog is exported from `morrow-legacy` through a deterministic donor-side inventory script. Browser-dependent Morrow execution will enter through one bounded bridge in a later checkpoint.

The public-facing catalog is generated from connected sources. A deterministic collision policy retains the higher-priority source name and assigns a stable source-prefixed alias to the other mapping. MindTap and Connect names are removed before publication or registration.

## Reasons

1. Meridian already provides a typed MCP surface with provider authority below the protocol layer.
2. Morrow already contains broad Canvas definitions, planners, approval data, readback logic, privacy controls, workflow state, and multi-course operations.
3. Reimplementing these systems before proving the external gateway would discard working behavior and create two new semantic authorities.
4. The gateway gives Codex, Claude Code, Gemini CLI, and other MCP clients one entry point immediately.
5. Source extraction can occur behind stable gateway contracts after the joined system is running.

## Runtime rules

- The gateway never constructs Canvas routes.
- The gateway never claims provider success on its own.
- The upstream that owns a tool remains responsible for its current policy, dispatch, and readback behavior during convergence.
- Result metadata records the exact upstream and catalog digest without exposing commands, credentials, or private paths.
- A duplicate tool name is never silently dropped.
- Held provider prefixes are filtered before tools are registered.

## Consequences

The first candidate is a federated system, not yet a standalone replacement for both donors. This is intentional. Each later extraction must preserve the external tool contract and pass parity tests before the gateway mapping changes.

A final public release still requires source-rights review, public-safe fixtures, provider authorization, and removal of private donor dependencies from the distributable profile.
